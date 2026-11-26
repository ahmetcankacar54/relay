//! The `sidebar-main` case of `tests/sidebar-layout.test.ts` ("Copy recipe writes the clipboard
//! in main…"); its other cases are in `tests/sidebar_layout.rs`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use relay_core::sidebar_main::{SidebarActionsDeps, SidebarGaps, sidebar_actions};

struct Gaps {
    id: String,
    events: Arc<Mutex<Vec<String>>>,
}

impl SidebarGaps for Gaps {
    fn sidebar_recipe(&self, asked: &str) -> Result<Option<String>, String> {
        Ok((asked == self.id).then(|| "the recipe".to_owned()))
    }
    fn dismiss_sidebar_gap(&self, asked: &str) -> Result<(), String> {
        self.events.lock().unwrap().push(format!("dismiss:{asked}"));
        Ok(())
    }
}

#[test]
fn copy_recipe_writes_the_clipboard_in_main_resolves_with_nothing_and_keeps_the_offer() {
    let id = uuid::Uuid::new_v4().to_string();
    let clipboard = Arc::new(Mutex::new(Vec::<String>::new()));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let changed = Arc::new(AtomicUsize::new(0));
    let (written, counted, logged) = (
        Arc::clone(&clipboard),
        Arc::clone(&changed),
        Arc::clone(&events),
    );
    let actions = sidebar_actions(SidebarActionsDeps {
        gaps: Box::new(Gaps {
            id: id.clone(),
            events: Arc::clone(&events),
        }),
        write_clipboard: Box::new(move |text| written.lock().unwrap().push(text.to_owned())),
        changed: Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }),
        log: Some(Box::new(move |event, fields| {
            let fields = fields.map_or(Value::Null, |f| Value::Object(f.clone()));
            logged.lock().unwrap().push(format!("{event}:{fields}"));
        })),
    });
    assert_eq!(actions.copy(&json!(id)), Ok(()));
    assert_eq!(*clipboard.lock().unwrap(), ["the recipe"]);
    let gone = actions
        .copy(&json!(uuid::Uuid::new_v4().to_string()))
        .unwrap_err();
    assert!(gone.to_string().contains("no longer there"));
    assert!(actions.copy(&json!("not-an-id")).is_err());
    assert_eq!(*clipboard.lock().unwrap(), ["the recipe"]);
    assert_eq!(actions.dismiss(&json!(id)), Ok(()));
    assert!(actions.dismiss(&json!("../x")).is_err());
    let events = events.lock().unwrap();
    assert!(events.contains(&format!("dismiss:{id}")));
    assert!(events.iter().all(|e| !e.contains("the recipe")));
    assert_eq!(changed.load(Ordering::SeqCst), 3);
}
