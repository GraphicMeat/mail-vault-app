//! A per-renderer cache of converted images.
//!
//! Converting a [`peniko::ImageData`] to a vello_cpu `Pixmap` (format swizzle +
//! alpha premultiplication) is expensive, so converted images are registered in
//! the vello_cpu image registry once and subsequent draws reference them by
//! [`ImageId`].

use peniko::WeakBlob;
use std::collections::HashMap;
use vello_common::paint::{ImageId, ImageSource};
use vello_cpu::Resources;

use crate::image_convert::convert_image;

/// Configuration for the image cache eviction policy.
#[derive(Clone, Copy, Debug)]
pub struct ImageCacheConfig {
    /// Evict entries unused for this many frames.
    pub max_age: u64,
    /// Soft cap on total converted-pixmap bytes.
    pub max_bytes: usize,
    /// Only walk the cache every N frames unless over budget.
    pub prune_interval: u64,
}

impl Default for ImageCacheConfig {
    fn default() -> Self {
        Self {
            max_age: 64,
            max_bytes: 64 * 1024 * 1024,
            prune_interval: 8,
        }
    }
}

struct Entry {
    image_id: ImageId,
    may_have_transparency: bool,
    bytes: usize,
    last_used: u64,
    /// Weak handle to the source data. When the embedder drops the last strong
    /// reference (e.g. a document is destroyed), the entry is evicted at the
    /// next prune.
    source: WeakBlob<u8>,
}

/// Caches image conversions, keyed on the source blob's unique id.
#[derive(Default)]
pub(crate) struct ImageCache {
    entries: HashMap<u64, Entry>,
    serial: u64,
    total_bytes: usize,
    config: ImageCacheConfig,
}

impl ImageCache {
    pub(crate) fn new(config: ImageCacheConfig) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }

    /// Look up the converted image for `image`, converting and registering it
    /// in `resources` on a cache miss.
    pub(crate) fn get_or_register(
        &mut self,
        resources: &mut Resources,
        image: &peniko::ImageData,
    ) -> ImageSource {
        let serial = self.serial;
        let total_bytes = &mut self.total_bytes;
        let entry = self.entries.entry(image.data.id()).or_insert_with(|| {
            let pixmap = convert_image(image);
            let may_have_transparency = pixmap.may_have_transparency();
            let bytes = pixmap.data().len() * 4;
            *total_bytes += bytes;
            Entry {
                image_id: resources.register_image(pixmap),
                may_have_transparency,
                bytes,
                last_used: serial,
                source: image.data.downgrade(),
            }
        });
        entry.last_used = serial;
        ImageSource::opaque_id_with_transparency_hint(entry.image_id, entry.may_have_transparency)
    }

    /// Advance the frame counter and evict stale entries.
    ///
    /// Must be called once per frame, after rendering (so that ids referenced
    /// by the just-rendered scene are not destroyed before being resolved).
    pub(crate) fn maintain(&mut self, resources: &mut Resources) {
        self.serial += 1;
        let over_budget = self.total_bytes > self.config.max_bytes;
        if !over_budget && !self.serial.is_multiple_of(self.config.prune_interval) {
            return;
        }

        // Evict entries whose source data has been dropped or that have not
        // been used recently.
        let serial = self.serial;
        let max_age = self.config.max_age;
        let total_bytes = &mut self.total_bytes;
        self.entries.retain(|_, entry| {
            let keep = entry.source.upgrade().is_some() && serial - entry.last_used <= max_age;
            if !keep {
                *total_bytes -= entry.bytes;
                resources.destroy_image(entry.image_id);
            }
            keep
        });

        // Evict least-recently-used entries until under the byte budget,
        // skipping entries used by the frame that was just rendered.
        while self.total_bytes > self.config.max_bytes {
            let key = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.last_used + 1 != serial)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| *key);
            let Some(key) = key else { break };
            let entry = self.entries.remove(&key).unwrap();
            self.total_bytes -= entry.bytes;
            resources.destroy_image(entry.image_id);
        }
    }

    /// Drop all cached conversions and their registry entries.
    pub(crate) fn clear(&mut self, resources: &mut Resources) {
        for (_, entry) in self.entries.drain() {
            resources.destroy_image(entry.image_id);
        }
        self.total_bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};
    use std::sync::Arc;

    fn image(pixels: &[[u8; 4]]) -> ImageData {
        ImageData {
            data: Blob::new(Arc::new(pixels.concat())),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: pixels.len() as u32,
            height: 1,
        }
    }

    #[test]
    fn cache_hit_reuses_registered_image() {
        let mut cache = ImageCache::new(ImageCacheConfig::default());
        let mut resources = Resources::new();
        let img = image(&[[0, 0, 0, 255]]);
        let a = cache.get_or_register(&mut resources, &img);
        let b = cache.get_or_register(&mut resources, &img);
        let ImageSource::OpaqueId { id: id_a, .. } = a else {
            panic!("expected OpaqueId");
        };
        let ImageSource::OpaqueId { id: id_b, .. } = b else {
            panic!("expected OpaqueId");
        };
        assert_eq!(id_a, id_b);
        assert_eq!(cache.entries.len(), 1);
    }

    #[test]
    fn dead_blob_is_evicted() {
        let mut cache = ImageCache::new(ImageCacheConfig {
            prune_interval: 1,
            ..Default::default()
        });
        let mut resources = Resources::new();
        let img = image(&[[0, 0, 0, 255]]);
        let ImageSource::OpaqueId { id, .. } = cache.get_or_register(&mut resources, &img) else {
            panic!("expected OpaqueId");
        };
        drop(img);
        cache.maintain(&mut resources);
        assert!(cache.entries.is_empty());
        assert_eq!(cache.total_bytes, 0);
        assert!(resources.resolve_image(id).is_none());
    }

    #[test]
    fn old_entries_age_out() {
        let mut cache = ImageCache::new(ImageCacheConfig {
            max_age: 2,
            prune_interval: 1,
            ..Default::default()
        });
        let mut resources = Resources::new();
        let img = image(&[[0, 0, 0, 255]]);
        cache.get_or_register(&mut resources, &img);
        for _ in 0..2 {
            cache.maintain(&mut resources);
        }
        assert_eq!(cache.entries.len(), 1);
        cache.maintain(&mut resources);
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn byte_budget_evicts_lru_but_not_current_frame() {
        let mut cache = ImageCache::new(ImageCacheConfig {
            max_bytes: 4,
            ..Default::default()
        });
        let mut resources = Resources::new();
        let old = image(&[[0, 0, 0, 255]]);
        let new = image(&[[1, 1, 1, 255]]);
        cache.get_or_register(&mut resources, &old);
        cache.maintain(&mut resources);
        cache.get_or_register(&mut resources, &new);
        cache.maintain(&mut resources);
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.entries.contains_key(&new.data.id()));
    }

    #[test]
    fn clear_destroys_registry_entries() {
        let mut cache = ImageCache::new(ImageCacheConfig::default());
        let mut resources = Resources::new();
        let img = image(&[[0, 0, 0, 255]]);
        let ImageSource::OpaqueId { id, .. } = cache.get_or_register(&mut resources, &img) else {
            panic!("expected OpaqueId");
        };
        cache.clear(&mut resources);
        assert!(cache.entries.is_empty());
        assert!(resources.resolve_image(id).is_none());
    }
}
