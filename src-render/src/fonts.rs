//! The worker's fonts. One master `FontContext` (system fonts, blitz's bullet
//! font, plus every Google Font family the daemon sent) that every document
//! gets a clone of. blitz keeps a document's context private
//! (`BaseDocument.font_ctx` is pub(crate)), so a family that arrives later is
//! applied by rebuilding the documents that name it (worker.rs).
use blitz_dom::FontContext;
use parley::fontique::{Blob, Collection, CollectionOptions, FontInfoOverride, FontStyle, FontWeight, SourceCache};
use std::collections::BTreeSet;
use std::sync::Arc;

pub struct FaceData {
    pub data: Vec<u8>,
    pub weight: u16,
    pub style: String,
}

pub struct FontLibrary {
    ctx: FontContext,
    families: BTreeSet<String>, // lowercased
}

impl FontLibrary {
    /// Mirrors blitz's default construction (document.rs:399-410): the same
    /// collection options and the bullet font, or list markers draw nothing.
    pub fn new(system_fonts: bool) -> Self {
        let mut ctx = FontContext {
            source_cache: SourceCache::new_shared(),
            collection: Collection::new(CollectionOptions { shared: false, system_fonts }),
        };
        ctx.collection.register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT)), None);
        Self { ctx, families: BTreeSet::new() }
    }

    pub fn has(&self, family: &str) -> bool {
        self.families.contains(&family.to_lowercase())
    }

    /// Registers `faces` as `family`. True when the family was not known yet.
    pub fn register(&mut self, family: &str, faces: Vec<FaceData>) -> bool {
        let new = self.families.insert(family.to_lowercase());
        if !new {
            return false;
        }
        for face in faces {
            // register_fonts does not decode WOFF/WOFF2 itself.
            let bytes = blitz_dom::decode_font_bytes(&face.data).into_owned();
            let style = if face.style == "italic" { Some(FontStyle::Italic) } else { Some(FontStyle::Normal) };
            self.ctx.collection.register_fonts(
                Blob::new(Arc::new(bytes)),
                Some(FontInfoOverride {
                    family_name: Some(family),
                    weight: Some(FontWeight::new(face.weight as f32)),
                    style,
                    ..Default::default()
                }),
            );
        }
        true
    }

    /// An independent clone: families registered later do not reach it.
    pub fn context(&self) -> FontContext {
        self.ctx.clone()
    }
}
