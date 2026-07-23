//! In-app purchase entitlement bridge.
//!
//! - On Mac App Store builds (`feature = "appstore"`) this is a full StoreKit
//!   bridge implemented via `objc2-store-kit`.
//! - On every other build it falls back to a stub that grants entitlement
//!   unconditionally — non-MAS distribution channels are not paywalled.
//!
//! Frontend code calls the same `iap_*` Tauri commands in either build.

#[cfg(all(target_os = "macos", feature = "appstore"))]
mod imp {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString, NSUserDefaults};
    use objc2_store_kit::{
        SKMutablePayment, SKPaymentQueue, SKPaymentTransaction, SKPaymentTransactionObserver,
        SKPaymentTransactionState,
    };
    use tokio::sync::oneshot;
    use tracing::{error, info, warn};

    const ENTITLEMENT_KEY_PREFIX: &str = "mv.iap.entitled.";

    #[derive(Default)]
    struct PendingWaiters {
        purchases: HashMap<String, oneshot::Sender<Result<(), String>>>,
        restore: Option<oneshot::Sender<Result<(), String>>>,
    }

    static PENDING: std::sync::LazyLock<Mutex<PendingWaiters>> =
        std::sync::LazyLock::new(|| Mutex::new(PendingWaiters::default()));

    fn take_purchase_waiter(product_id: &str) -> Option<oneshot::Sender<Result<(), String>>> {
        PENDING.lock().ok()?.purchases.remove(product_id)
    }

    fn take_restore_waiter() -> Option<oneshot::Sender<Result<(), String>>> {
        PENDING.lock().ok()?.restore.take()
    }

    pub fn is_entitled(product_id: &str) -> bool {
        if std::env::var("MV_IAP_DEV_ENTITLE").ok().as_deref() == Some("1") {
            return true;
        }
        let key = format!("{ENTITLEMENT_KEY_PREFIX}{product_id}");
        let defaults = unsafe { NSUserDefaults::standardUserDefaults() };
        let ns_key = NSString::from_str(&key);
        unsafe { defaults.boolForKey(&ns_key) }
    }

    fn set_entitled(product_id: &str, value: bool) {
        let key = format!("{ENTITLEMENT_KEY_PREFIX}{product_id}");
        let defaults = unsafe { NSUserDefaults::standardUserDefaults() };
        let ns_key = NSString::from_str(&key);
        unsafe { defaults.setBool_forKey(value, &ns_key) };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MVTxObserver"]
        struct TxObserver;

        unsafe impl NSObjectProtocol for TxObserver {}

        unsafe impl SKPaymentTransactionObserver for TxObserver {
            #[unsafe(method(paymentQueue:updatedTransactions:))]
            fn payment_queue_updated_transactions(
                &self,
                queue: &SKPaymentQueue,
                transactions: &NSArray<SKPaymentTransaction>,
            ) {
                handle_updated_transactions(queue, transactions);
            }

            #[unsafe(method(paymentQueueRestoreCompletedTransactionsFinished:))]
            fn payment_queue_restore_finished(&self, _queue: &SKPaymentQueue) {
                info!("[iap] restoreCompletedTransactionsFinished");
                if let Some(tx) = take_restore_waiter() {
                    let _ = tx.send(Ok(()));
                }
            }

            #[unsafe(method(paymentQueue:restoreCompletedTransactionsFailedWithError:))]
            fn payment_queue_restore_failed(
                &self,
                _queue: &SKPaymentQueue,
                error: &objc2_foundation::NSError,
            ) {
                let msg = unsafe { error.localizedDescription() }.to_string();
                error!("[iap] restoreCompletedTransactionsFailedWithError: {msg}");
                if let Some(tx) = take_restore_waiter() {
                    let _ = tx.send(Err(msg));
                }
            }
        }
    );

    fn handle_updated_transactions(
        queue: &SKPaymentQueue,
        transactions: &NSArray<SKPaymentTransaction>,
    ) {
        for tx in transactions.iter() {
            let state = unsafe { tx.transactionState() };
            let product_id = unsafe {
                let payment = tx.payment();
                payment.productIdentifier().to_string()
            };
            info!("[iap] transaction state={:?} product={}", state, product_id);

            match state {
                SKPaymentTransactionState::Purchased
                | SKPaymentTransactionState::Restored => {
                    set_entitled(&product_id, true);
                    if let Some(waiter) = take_purchase_waiter(&product_id) {
                        let _ = waiter.send(Ok(()));
                    }
                    unsafe { queue.finishTransaction(&tx) };
                }
                SKPaymentTransactionState::Failed => {
                    let err_msg = unsafe { tx.error() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "Purchase failed".to_string());
                    warn!("[iap] purchase failed: {err_msg}");
                    if let Some(waiter) = take_purchase_waiter(&product_id) {
                        let _ = waiter.send(Err(err_msg));
                    }
                    unsafe { queue.finishTransaction(&tx) };
                }
                _ => {
                    // Purchasing / Deferred — wait for next update.
                }
            }
        }
    }

    pub struct IapState {
        observer: Mutex<Option<Retained<TxObserver>>>,
    }

    impl IapState {
        pub fn new() -> Self {
            Self { observer: Mutex::new(None) }
        }
    }

    impl Default for IapState {
        fn default() -> Self {
            Self::new()
        }
    }

    pub fn install_observer(state: &IapState) {
        let mut guard = match state.observer.lock() {
            Ok(g) => g,
            Err(e) => {
                error!("[iap] observer mutex poisoned: {e}");
                return;
            }
        };
        if guard.is_some() {
            return;
        }
        unsafe {
            let observer: Retained<TxObserver> = msg_send![TxObserver::alloc(), init];
            let queue = SKPaymentQueue::defaultQueue();
            let proto: &ProtocolObject<dyn SKPaymentTransactionObserver> =
                ProtocolObject::from_ref(&*observer);
            queue.addTransactionObserver(proto);
            *guard = Some(observer);
        }
        info!("[iap] SKPaymentTransactionObserver installed");
    }

    pub async fn purchase(product_id: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = PENDING
                .lock()
                .map_err(|e| format!("pending lock poisoned: {e}"))?;
            if let Some(prev) = pending.purchases.insert(product_id.to_string(), tx) {
                let _ = prev.send(Err("superseded by newer purchase request".into()));
            }
        }

        let pid = product_id.to_string();
        let spawn_result = std::thread::Builder::new()
            .name("iap-purchase".into())
            .spawn(move || unsafe {
                let payment = SKMutablePayment::new();
                let ns_id = NSString::from_str(&pid);
                payment.setProductIdentifier(&ns_id);
                let queue = SKPaymentQueue::defaultQueue();
                queue.addPayment(&payment);
            });

        if let Err(e) = spawn_result {
            let _ = take_purchase_waiter(product_id);
            return Err(format!("failed to enqueue payment: {e}"));
        }

        rx.await
            .map_err(|_| "purchase result channel dropped".to_string())?
    }

    pub async fn restore() -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = PENDING
                .lock()
                .map_err(|e| format!("pending lock poisoned: {e}"))?;
            if let Some(prev) = pending.restore.take() {
                let _ = prev.send(Err("superseded by newer restore request".into()));
            }
            pending.restore = Some(tx);
        }

        let spawn_result = std::thread::Builder::new()
            .name("iap-restore".into())
            .spawn(|| unsafe {
                let queue = SKPaymentQueue::defaultQueue();
                queue.restoreCompletedTransactions();
            });

        if let Err(e) = spawn_result {
            let _ = take_restore_waiter();
            return Err(format!("failed to start restore: {e}"));
        }

        rx.await
            .map_err(|_| "restore result channel dropped".to_string())?
    }
}

#[cfg(not(all(target_os = "macos", feature = "appstore")))]
mod imp {
    //! Non-MAS builds: backups are not paywalled. All entitlement checks
    //! return true; purchase/restore are no-ops that succeed immediately.

    #[derive(Default)]
    pub struct IapState;

    impl IapState {
        pub fn new() -> Self { Self }
    }

    pub fn install_observer(_state: &IapState) {}

    pub fn is_entitled(_product_id: &str) -> bool { true }

    pub async fn purchase(_product_id: &str) -> Result<(), String> { Ok(()) }
    pub async fn restore() -> Result<(), String> { Ok(()) }
}

pub use imp::{install_observer, is_entitled, purchase, restore, IapState};

