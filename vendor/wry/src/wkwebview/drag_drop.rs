// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{ffi::CStr, path::PathBuf};

use objc2::{
  runtime::{Bool, ProtocolObject},
  ClassType, DeclaredClass,
};
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSFilenamesPboardType, NSPasteboard};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSString, NSURL};

use crate::DragDropEvent;

use super::WryWebView;

pub(crate) unsafe fn collect_paths(drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  paths_from_pasteboard(&drag_info.draggingPasteboard())
}

// MailVault backport of upstream wry 0.57's `collect_paths` (no unwraps).
unsafe fn paths_from_pasteboard(pb: &NSPasteboard) -> Vec<PathBuf> {
  let mut drag_drop_paths = Vec::new();

  // `readObjectsForClasses:options:` covers both sources publishing per-item
  // `public.file-url` types and the legacy `NSFilenamesPboardType` payload,
  // which `propertyListForType:` can fail to materialize even when
  // `availableTypeFromArray:` advertises it.
  let url_classes = NSArray::from_slice(&[NSURL::class()]);
  if let Some(items) = pb.readObjectsForClasses_options(&url_classes, None) {
    for item in items.iter() {
      if let Some(url) = item.downcast_ref::<NSURL>() {
        if !url.isFileURL() {
          continue;
        }
        // `filePathURL` resolves file reference URLs (`file:///.file/id=...`)
        // to file path URLs, and returns `None` when resolution fails.
        if let Some(path) = url.filePathURL().and_then(|url| url.path()) {
          let path = CStr::from_ptr(path.UTF8String()).to_string_lossy();
          drag_drop_paths.push(PathBuf::from(path.into_owned()));
        }
      }
    }
    if !drag_drop_paths.is_empty() {
      return drag_drop_paths;
    }
  }

  let types = NSArray::arrayWithObject(NSFilenamesPboardType);
  if pb.availableTypeFromArray(&types).is_some() {
    if let Some(paths) = pb.propertyListForType(NSFilenamesPboardType) {
      if let Ok(paths) = paths.downcast::<NSArray>() {
        for path in paths {
          if let Ok(path) = path.downcast::<NSString>() {
            let path = CStr::from_ptr(path.UTF8String()).to_string_lossy();
            drag_drop_paths.push(PathBuf::from(path.into_owned()));
          }
        }
      }
    }
  }
  drag_drop_paths
}

pub(crate) fn dragging_entered(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Enter { paths, position }) {
    // Reject the Wry file drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), draggingEntered: drag_info] }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn dragging_updated(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Over { position }) {
    unsafe {
      let os_operation = objc2::msg_send![super(this), draggingUpdated: drag_info];
      if os_operation == NSDragOperation::None {
        // 0 will be returned for a drop on any arbitrary location on the webview.
        // We'll override that with NSDragOperationCopy.
        NSDragOperation::Copy
      } else {
        // A different NSDragOperation is returned when a file is hovered over something like
        // a <input type="file">, so we'll make sure to preserve that behaviour.
        os_operation
      }
    }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn perform_drag_operation(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Drop { paths, position }) {
    // Reject the Wry drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), performDragOperation: drag_info] }
  } else {
    Bool::YES
  }
}

pub(crate) fn dragging_exited(this: &WryWebView, drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Leave) {
    // Reject the Wry drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), draggingExited: drag_info] }
  }
}

// MailVault: a drag whose pasteboard advertises file names it cannot hand
// over (a macOS screenshot thumbnail dragged into the sandboxed app, whose
// file URL has no sandbox extension yet) must read as "no paths", never panic:
// the panic ran in AppKit's drag callback and took the whole app down.
#[cfg(all(test, target_os = "macos"))]
mod tests {
  use super::*;
  use std::panic::{catch_unwind, AssertUnwindSafe};

  #[test]
  fn advertised_file_names_without_data_read_as_no_paths() {
    let pb = NSPasteboard::pasteboardWithUniqueName();
    unsafe {
      let types = NSArray::arrayWithObject(NSFilenamesPboardType);
      pb.declareTypes_owner(&types, None);
    }
    let read = catch_unwind(AssertUnwindSafe(|| unsafe { paths_from_pasteboard(&pb) }));
    assert_eq!(read.expect("reading the drag pasteboard panicked"), Vec::<PathBuf>::new());
  }

  #[test]
  fn a_file_url_on_the_pasteboard_reads_as_its_path() {
    let dir = std::env::temp_dir().join(format!("wry-drop-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("Screenshot.png");
    std::fs::write(&file, b"png").unwrap();
    let file = file.canonicalize().unwrap();

    let pb = NSPasteboard::pasteboardWithUniqueName();
    let url = NSURL::fileURLWithPath(&NSString::from_str(file.to_str().unwrap()));
    pb.clearContents();
    assert!(pb.writeObjects(&NSArray::from_slice(&[ProtocolObject::from_ref(&*url)])));

    let read = catch_unwind(AssertUnwindSafe(|| unsafe { paths_from_pasteboard(&pb) }));
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(read.expect("reading the drag pasteboard panicked"), vec![file]);
  }
}
