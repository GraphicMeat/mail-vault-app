//! The worker's fonts. One master `FontContext` (system fonts, blitz's bullet
//! font, plus every Google Font family the daemon sent) that every document
//! gets a clone of. blitz keeps a document's context private
//! (`BaseDocument.font_ctx` is pub(crate)), so a family that arrives later is
//! applied by rebuilding the documents that name it (worker.rs).
use blitz_dom::FontContext;
use parley::fontique::{
    Blob, Collection, CollectionOptions, FontInfo, FontInfoOverride, FontStyle, FontWeight, SourceCache, SourceId, SourceInfo, SourceKind,
};
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
        // fontique gives a family one font per weight and style: the first one
        // registered for an exact weight, the last of a tie for a near one. A
        // css2 family comes as several subset files per weight (latin-ext is
        // listed before latin), so only the subset that draws the most Basic
        // Latin is kept; the other subsets' letters go to the next family in
        // the stack.
        let mut kept: Vec<(u16, bool, Blob<u8>, usize)> = Vec::new();
        for face in faces {
            // register_fonts does not decode WOFF/WOFF2 itself.
            let blob = Blob::new(Arc::new(blitz_dom::decode_font_bytes(&face.data).into_owned()));
            let italic = face.style == "italic";
            let latin = basic_latin_coverage(&blob);
            match kept.iter().position(|(w, i, ..)| *w == face.weight && *i == italic) {
                None => kept.push((face.weight, italic, blob, latin)),
                Some(at) if latin > kept[at].3 => kept[at] = (face.weight, italic, blob, latin),
                Some(_) => {}
            }
        }
        for (weight, italic, blob, _) in kept {
            self.ctx.collection.register_fonts(
                blob,
                Some(FontInfoOverride {
                    family_name: Some(family),
                    weight: Some(FontWeight::new(weight as f32)),
                    style: Some(if italic { FontStyle::Italic } else { FontStyle::Normal }),
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

/// How many of A-Z, a-z and 0-9 the font maps: all of them in a latin subset,
/// few or none in a latin-ext one.
fn basic_latin_coverage(blob: &Blob<u8>) -> usize {
    let source = SourceInfo::new(SourceId::new(), SourceKind::Memory(blob.clone()));
    let Some(info) = FontInfo::from_source(source, 0) else { return 0 };
    let Some(map) = info.charmap_index().charmap(blob.as_ref()) else { return 0 };
    ('A'..='Z').chain('a'..='z').chain('0'..='9').filter(|c| map.map(*c).is_some()).count()
}
