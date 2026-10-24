//! Process-local exclusion for native mutations of an authorized mail mirror.
//! Resolve only an existing root. Hold no local vault lock while resolving or
//! waiting, and never acquire the flag writer from inside a mirror unit.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, Weak}};

#[derive(Clone, Debug)]
pub struct MirrorRoot {
    path: PathBuf,
    mutation: Arc<Mutex<u64>>,
}

impl MirrorRoot {
    pub fn resolve(root: &Path) -> Result<Self, String> {
        let path = std::fs::canonicalize(root).map_err(|e| format!("Backup folder unavailable: {e}"))?;
        if !path.is_dir() { return Err("Backup folder unavailable".into()); }
        static ROOTS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<u64>>>>> = OnceLock::new();
        let mut roots = ROOTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        roots.retain(|_, value| value.strong_count() > 0);
        let mutation = roots.get(&path).and_then(Weak::upgrade).unwrap_or_else(|| {
            let mutation = Arc::new(Mutex::new(0));
            roots.insert(path.clone(), Arc::downgrade(&mutation));
            mutation
        });
        Ok(Self { path, mutation })
    }

    /// Rebase a caller-derived path using the explicit original root. This
    /// never guesses a root from mailbox parents.
    pub fn rebase(&self, original_root: &Path, path: &Path) -> Result<PathBuf, String> {
        let relative = path.strip_prefix(original_root).map_err(|_| "Mirror path outside root".to_string())?;
        if relative.components().any(|c| !matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
            return Err("Mirror path outside root".into());
        }
        Ok(self.path.join(relative))
    }

    pub fn path(&self) -> &Path { &self.path }

    /// One bounded, synchronous mirror-only unit. Non-reentrant. The handle's
    /// strong Arc lives throughout waiting and mutation; map locks never do.
    /// Each unit refuses a root that disappeared since resolution.
    pub fn mutate<T>(&self, work: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
        self.mutate_versioned(|path, _| work(path))?
    }
    pub(crate) fn same_guard(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.mutation, &other.mutation)
    }

    // A caller-owned listing can stay cheap between uncontended units. Every
    // native mutation invalidates other callers' cached filename observations.
    pub(crate) fn mutate_versioned<T>(&self, work: impl FnOnce(&Path, u64) -> T) -> Result<T, String> {
        let mut revision = self.mutation.lock().unwrap_or_else(|e| e.into_inner());
        // A retained handle does not authorize recreating a drive that went
        // away between units. Check under exclusion before any nested mkdir.
        if !self.path.is_dir() { return Err("Backup folder unavailable".into()); }
        let before = *revision;
        *revision = revision.wrapping_add(1);
        Ok(work(&self.path, before))
    }

}

/// Convenience for existing helpers carrying an explicit root and derived path.
pub fn mutate_at<T>(root: &Path, path: &Path, work: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    let handle = MirrorRoot::resolve(root)?;
    let path = handle.rebase(root, path)?;
    handle.mutate(|_| work(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_exclusion_aliases_share_identity_and_roots_are_independent() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let root = MirrorRoot::resolve(a.path()).unwrap();
        let alias = MirrorRoot::resolve(&a.path().join(".")).unwrap();
        let other = MirrorRoot::resolve(b.path()).unwrap();
        assert!(Arc::ptr_eq(&root.mutation, &alias.mutation));
        assert!(!Arc::ptr_eq(&root.mutation, &other.mutation));
        root.mutate(|_| {
            assert!(alias.mutation.try_lock().is_err());
            other.mutate(|path| std::fs::write(path.join("independent"), b"ok").map_err(|e| e.to_string())).unwrap();
            Ok(())
        }).unwrap();
        let nested = a.path().join("me@test/Projects/Sub/cur");
        assert_eq!(root.rebase(a.path(), &nested).unwrap(), root.path().join("me@test/Projects/Sub/cur"));
        assert!(root.rebase(a.path(), &a.path().join("../outside")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn mirror_exclusion_symlink_root_uses_canonical_identity() {
        let base = tempfile::tempdir().unwrap();
        let actual = base.path().join("actual");
        std::fs::create_dir(&actual).unwrap();
        let alias = base.path().join("alias");
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        let a = MirrorRoot::resolve(&actual).unwrap();
        let b = MirrorRoot::resolve(&alias).unwrap();
        assert!(Arc::ptr_eq(&a.mutation, &b.mutation));
    }

    #[test]
    fn mirror_exclusion_missing_root_is_not_created() {
        let base = tempfile::tempdir().unwrap();
        let missing = base.path().join("absent-drive");
        assert!(MirrorRoot::resolve(&missing).is_err());
        assert!(mutate_at(&missing, &missing.join("me@test/Nested/Sub/cur"), |p| {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())
        }).is_err());
        assert!(!missing.exists());
    }
}
