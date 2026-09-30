//! The Dock icon's right-click menu (macOS). Tauri has no API for it, so this adds the standard
//! `applicationDockMenu:` method to the app's delegate at runtime and points two items at our own actions.

use std::{ffi::c_char, sync::OnceLock};

use objc2::{
    define_class, ffi, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{NSObject, NSString};
use tauri::AppHandle;

static HANDLE: OnceLock<AppHandle> = OnceLock::new();
/// The action target, leaked on purpose: menu items hold their target weakly and the menu is rebuilt on every click.
static TARGET: OnceLock<usize> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "BraidDockActions"]
    struct DockActions;

    impl DockActions {
        #[unsafe(method(braidNewWindow:))]
        fn new_window(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = HANDLE.get() {
                crate::new_window(app.clone());
            }
        }

        #[unsafe(method(braidOpenRepo:))]
        fn open_repo(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = HANDLE.get() {
                crate::switch_focused(app.clone());
            }
        }
    }
);

extern "C" fn application_dock_menu(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> *mut NSMenu {
    // AppKit only calls this on the main thread.
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let menu = NSMenu::new(mtm);
    if let Some(&target) = TARGET.get() {
        let target = target as *mut AnyObject;
        for (title, action) in [("New Window", sel!(braidNewWindow:)), ("Open Repository...", sel!(braidOpenRepo:))] {
            let item = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    mtm.alloc(),
                    &NSString::from_str(title),
                    Some(action),
                    &NSString::from_str(""),
                )
            };
            unsafe { item.setTarget(Some(&*target)) };
            menu.addItem(&item);
        }
    }
    Retained::autorelease_return(menu)
}

/// Call once from the main thread after the app has started (the delegate must exist).
pub fn install(app: AppHandle) {
    let _ = HANDLE.set(app);
    let Some(mtm) = MainThreadMarker::new() else { return };
    let target: Retained<DockActions> = unsafe { msg_send![DockActions::alloc(mtm), init] };
    let _ = TARGET.set(Retained::into_raw(target) as usize);

    let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else { return };
    let class: &AnyClass = unsafe { msg_send![&*delegate, class] };
    let imp: Imp = unsafe {
        std::mem::transmute::<extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu, Imp>(application_dock_menu)
    };
    // "@" object result, "@" self, ":" selector, "@" sender.
    unsafe {
        ffi::class_addMethod(class as *const AnyClass as *mut _, sel!(applicationDockMenu:), imp, b"@@:@\0".as_ptr() as *const c_char);
    }
}
