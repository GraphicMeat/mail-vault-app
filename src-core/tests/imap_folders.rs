//! CREATE / RENAME / DELETE and the Trash rule — Thunderbird parity G4.
mod common;
use common::session;
use mailvault_core::imap::*;
use mock_imap::state::Mailbox;
use mock_imap::{Action, MockImap, Scenario, Trigger};

#[async_std::test]
async fn create_makes_the_folder_and_subscribes_it() {
    let server = MockImap::start(Scenario::new());
    let mut sess = session(&server).await;
    create_mailbox(&mut sess, "Projects/Alpha").await.expect("create");
    assert!(server.state().find("Projects/Alpha").is_some());
    assert_eq!(server.count_commands("SUBSCRIBE"), 1);
}

#[async_std::test]
async fn create_of_an_existing_folder_is_an_error_with_the_servers_text() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("Archive")));
    let mut sess = session(&server).await;
    let err = create_mailbox(&mut sess, "Archive").await.unwrap_err();
    assert!(err.contains("ALREADYEXISTS"), "{err}");
}

#[async_std::test]
async fn rename_closes_the_selected_mailbox_first_and_renames_inferiors() {
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("Projects")).mailbox(Mailbox::new("Projects/Alpha")),
    );
    let mut sess = session(&server).await;
    select_mailbox(&mut sess, "Projects").await.expect("select");
    rename_mailbox(&mut sess, "Projects", "Work").await.expect("rename");
    let cmds = server.commands();
    let close = cmds.iter().position(|c| c.to_uppercase().contains("CLOSE")).expect("CLOSE sent");
    let rename = cmds.iter().position(|c| c.to_uppercase().contains("RENAME")).unwrap();
    assert!(close < rename);
    let st = server.state();
    assert!(
        st.find("Work").is_some() && st.find("Work/Alpha").is_some() && st.find("Projects").is_none()
    );
}

#[async_std::test]
async fn delete_takes_the_deepest_folder_first() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\HasChildren", "\\Trash"]))
            .mailbox(Mailbox::new("Trash/Old"))
            .mailbox(Mailbox::new("Trash/Old/Deeper")),
    );
    let mut sess = session(&server).await;
    let n = delete_mailbox(&mut sess, &["Trash/Old".into(), "Trash/Old/Deeper".into()])
        .await
        .expect("delete");
    assert_eq!(n, 2);
    let cmds: Vec<String> = server
        .commands()
        .into_iter()
        .filter(|c| c.to_uppercase().contains("DELETE"))
        .collect();
    assert!(
        cmds[0].contains("Trash/Old/Deeper") && cmds[1].ends_with("\"Trash/Old\""),
        "{cmds:?}"
    );
    assert!(server.state().find("Trash/Old").is_none());
}

#[async_std::test]
async fn a_dead_socket_on_rename_is_an_error() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("A"))
            .fault(Trigger::on("RENAME"), Action::DropConnection),
    );
    let mut sess = session(&server).await;
    assert!(rename_mailbox(&mut sess, "A", "B").await.is_err());
}

#[test]
fn trash_rules() {
    assert_eq!(trash_destination("Projects/Alpha", "Trash", "/"), "Trash/Alpha");
    assert_eq!(trash_destination("INBOX.Kunden", "INBOX.Trash", "."), "INBOX.Trash.Kunden");
    assert!(is_under("Trash/Old", "Trash", "/") && is_under("Trash", "Trash", "/"));
    assert!(!is_under("Trashy", "Trash", "/"));
}
