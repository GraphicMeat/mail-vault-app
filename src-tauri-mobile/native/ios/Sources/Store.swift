// MailVault mobile: App Store subscriptions with StoreKit 2 (plan 4 Task 6). Called only from
// Rust (`storeProducts`, `storePurchase`, `storeRestore`; see ../../src/store.rs), never from JS.
//
// Every transaction goes to the engine's `mobile.premium.verify` through the shell's
// `mv_store_verify` (../../../src/store.rs) and is finished only when that answers `answered`:
// the billing server gave a verdict (a status, or a refusal). On a network failure or a rate
// limit it stays unfinished, so StoreKit hands it over again at the next launch (Review Focus 1).
//
// From the moment the plugin loads, `Transaction.updates` (renewals, Ask to Buy approvals, a
// purchase made on the App Store page) and `Transaction.unfinished` (a purchase the app was killed
// before verifying) are handed over too, another install's as well (a restored install's renewals
// carry the buying install's `appAccountToken`): the server decides. It answers the current state
// for an install in the purchase's set and refuses one that is not; either way the transaction is
// finished, so StoreKit stops handing it over at every launch. A refusal cannot take this
// install's Premium: the engine replaces its stored receipt only with an entitled one, and a "no"
// for another receipt is checked against the stored one first.
//
// The receipt never goes back to Rust's command reply or the page: the reply carries the outcome
// and the engine's answer only.

import Foundation
import MvShellC
import StoreKit
import Tauri

struct PurchaseArgs: Decodable {
  let productId: String
}

@available(iOS 16.0, *)
enum MvStore {
  static let productIds: Set<String> = [
    "com.mailvault.app.premium.monthly", "com.mailvault.app.premium.yearly",
  ]

  private static let lock = NSLock()
  private static var listening = false
  private static var installId: String?
  /// Transactions being handed over or already finished in this run: each goes over once at a
  /// time (`Transaction.updates` and `Transaction.unfinished` can both deliver one).
  private static var claimed = Set<UInt64>()
  /// The engine's answer for a transaction a listener handed over, for a purchase sheet that found
  /// it claimed (the listener got the same purchase first).
  private static var answers: [UInt64: Answer] = [:]

  /// The engine's answer for one transaction.
  struct Answer {
    let answered: Bool
    let reply: [String: Any]

    static let internalError = Answer(answered: false, reply: ["answered": false, "code": "INTERNAL"])
    static let unverified = Answer(answered: false, reply: ["answered": false, "code": "UNVERIFIED"])
  }

  /// Starts the transaction listeners once per process.
  static func start() {
    lock.lock()
    let first = !listening
    listening = true
    lock.unlock()
    guard first else { return }
    Task.detached(priority: .utility) {
      for await update in Transaction.updates { await handOver(update) }
    }
    Task.detached(priority: .utility) {
      for await pending in Transaction.unfinished { await handOver(pending) }
    }
  }

  private static func claim(_ id: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return claimed.insert(id).inserted
  }

  /// A transaction left unfinished may be handed over again later in this run.
  private static func unclaim(_ id: UInt64) {
    lock.lock()
    claimed.remove(id)
    lock.unlock()
  }

  /// Records what the engine answered for a transaction a listener handed over.
  private static func settle(_ id: UInt64, _ answer: Answer) {
    lock.lock()
    answers[id] = answer
    if !answer.answered { claimed.remove(id) }
    lock.unlock()
  }

  /// The listener's answer for a claimed transaction, waited for up to `seconds`; nil when it
  /// did not come (or the listener gave it back unanswered).
  private static func listenerAnswer(_ id: UInt64, seconds: Int) async -> Answer? {
    for _ in 0..<(seconds * 10) {
      lock.lock()
      let answer = answers.removeValue(forKey: id)
      let stillClaimed = claimed.contains(id)
      lock.unlock()
      if let answer = answer { return answer.answered ? answer : nil }
      if !stillClaimed { return nil }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return nil
  }

  /// Runs a blocking shell call on a GCD queue, never on the main thread or a Swift task's.
  private static func blocking<T>(_ work: @escaping () -> T) async -> T {
    await withCheckedContinuation { done in
      DispatchQueue.global(qos: .utility).async { done.resume(returning: work()) }
    }
  }

  /// This install's id from the engine (made on first use), cached for the process.
  static func install() async -> String? {
    lock.lock()
    let cached = installId
    lock.unlock()
    if let cached = cached { return cached }
    let id: String = await blocking {
      let raw = mv_store_install_id()
      defer { mv_free_string(raw) }
      guard let raw = raw else { return "" }
      return String(cString: raw)
    }
    guard !id.isEmpty else { return nil }
    lock.lock()
    installId = id
    lock.unlock()
    return id
  }

  /// Hands one verified transaction to the engine.
  static func verify(
    jws: String, productId: String, restore: Bool, appTransaction: String?
  ) async -> Answer {
    var args: [String: Any] = ["platform": "apple", "jws": jws, "productId": productId]
    if restore {
      args["restore"] = true
      if let proof = appTransaction { args["appTransaction"] = proof }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: args),
      let json = String(data: data, encoding: .utf8)
    else { return .internalError }
    return await blocking {
      let raw = json.withCString { mv_store_verify($0) }
      defer { mv_free_string(raw) }
      guard let raw = raw,
        let reply = try? JSONSerialization.jsonObject(with: Data(String(cString: raw).utf8))
          as? [String: Any]
      else { return .internalError }
      return Answer(answered: reply["answered"] as? Bool ?? false, reply: reply)
    }
  }

  /// Verifies `result` with the engine and finishes it when the server answered. An unverified
  /// transaction (StoreKit's own signature check failed) is neither sent nor finished: the server
  /// would refuse it and the engine would drop the Premium it has.
  static func submit(
    _ result: VerificationResult<Transaction>, restore: Bool, appTransaction: String?
  ) async -> Answer {
    guard case .verified(let transaction) = result else { return .unverified }
    let answer = await verify(
      jws: result.jwsRepresentation, productId: transaction.productID, restore: restore,
      appTransaction: appTransaction)
    if answer.answered { await transaction.finish() }
    return answer
  }

  /// A transaction from `Transaction.updates` or `.unfinished`: ours, once at a time, whichever
  /// install bought it (the server decides).
  static func handOver(_ result: VerificationResult<Transaction>) async {
    guard case .verified(let transaction) = result, productIds.contains(transaction.productID)
    else { return }
    guard claim(transaction.id) else { return }
    let answer = await submit(result, restore: false, appTransaction: nil)
    settle(transaction.id, answer)
  }

  static func isoPeriod(_ period: Product.SubscriptionPeriod) -> String {
    let unit: String
    switch period.unit {
    case .day: unit = "D"
    case .week: unit = "W"
    case .month: unit = "M"
    case .year: unit = "Y"
    @unknown default: unit = "?"
    }
    return "P\(period.value)\(unit)"
  }

  static func paymentMode(_ mode: Product.SubscriptionOffer.PaymentMode) -> String {
    if mode == .freeTrial { return "freeTrial" }
    if mode == .payAsYouGo { return "payAsYouGo" }
    if mode == .payUpFront { return "payUpFront" }
    return "unknown"
  }

  /// `{products: [{id, title, price, period, introOffer?}]}`: the store's localized names and
  /// prices; the intro offer only when this Apple account may still have it.
  static func products(_ invoke: Invoke) async {
    do {
      var out: [[String: Any]] = []
      for product in try await Product.products(for: Array(productIds)) {
        guard let sub = product.subscription else { continue }
        var item: [String: Any] = [
          "id": product.id, "title": product.displayName, "price": product.displayPrice,
          "period": isoPeriod(sub.subscriptionPeriod),
        ]
        if let offer = sub.introductoryOffer {
          let eligible = await sub.isEligibleForIntroOffer
          if eligible {
            item["introOffer"] = [
              "price": offer.displayPrice, "period": isoPeriod(offer.period),
              "paymentMode": paymentMode(offer.paymentMode), "periodCount": offer.periodCount,
            ]
          }
        }
        out.append(item)
      }
      invoke.resolve(["products": out])
    } catch {
      invoke.reject("the App Store is not available", code: "UNAVAILABLE")
    }
  }

  private static func reject(_ invoke: Invoke, _ error: Error) {
    if let purchase = error as? Product.PurchaseError, case .productUnavailable = purchase {
      invoke.reject("the App Store does not offer this", code: "NOT_FOUND")
    } else if let store = error as? StoreKitError, case .notAvailableInStorefront = store {
      invoke.reject("the App Store does not offer this here", code: "NOT_FOUND")
    } else {
      invoke.reject("the App Store is not available", code: "UNAVAILABLE")
    }
  }

  /// Buys `id` with this install's id as `appAccountToken`, then hands the transaction to the
  /// engine before answering `{status, platform, productId, verify?}`.
  static func purchase(_ id: String, _ invoke: Invoke) async {
    guard productIds.contains(id) else {
      invoke.reject("not a MailVault product", code: "INVALID")
      return
    }
    guard let install = await install(), let token = UUID(uuidString: install) else {
      invoke.reject("no install id", code: "INTERNAL")
      return
    }
    do {
      guard let product = try await Product.products(for: [id]).first else {
        invoke.reject("the App Store does not offer this", code: "NOT_FOUND")
        return
      }
      let result = try await product.purchase(options: [.appAccountToken(token)])
      var reply: [String: Any] = ["platform": "apple", "productId": id]
      switch result {
      case .success(let verification):
        reply["status"] = "purchased"
        if case .verified(let transaction) = verification {
          // `Transaction.updates` can deliver the same purchase while the sheet closes: then the
          // listener's answer is this purchase's, and it goes over once.
          var answer: Answer?
          if !claim(transaction.id) {
            answer = await listenerAnswer(transaction.id, seconds: 20)
          }
          if answer == nil {
            _ = claim(transaction.id)
            let mine = await submit(verification, restore: false, appTransaction: nil)
            if !mine.answered { unclaim(transaction.id) }
            answer = mine
          }
          reply["verify"] = (answer ?? .internalError).reply
        } else {
          reply["verify"] = Answer.unverified.reply
        }
      case .pending:
        // Ask to Buy or a payment that needs more: the approval arrives on `Transaction.updates`.
        reply["status"] = "pending"
      case .userCancelled:
        reply["status"] = "cancelled"
      @unknown default:
        reply["status"] = "cancelled"
      }
      invoke.resolve(reply)
    } catch StoreKitError.userCancelled {
      invoke.resolve(["status": "cancelled", "platform": "apple", "productId": id])
    } catch {
      reject(invoke, error)
    }
  }

  /// Restore Purchases: `AppStore.sync()` (may ask the user to sign in), then each current
  /// entitlement of ours goes to the engine as a restore with the AppTransaction as proof of the
  /// account (sent whether StoreKit verified it or not: the server checks it). Answers
  /// `{items: [{platform, productId, verify}]}`.
  static func restore(_ invoke: Invoke) async {
    var syncError: Error?
    do {
      try await AppStore.sync()
    } catch {
      syncError = error
    }
    let proof = (try? await AppTransaction.shared)?.jwsRepresentation
    var items: [[String: Any]] = []
    for await result in Transaction.currentEntitlements {
      let transaction = result.unsafePayloadValue
      guard productIds.contains(transaction.productID) else { continue }
      let answer = await submit(result, restore: true, appTransaction: proof)
      items.append([
        "platform": "apple", "productId": transaction.productID, "verify": answer.reply,
      ])
    }
    if items.isEmpty, let error = syncError {
      if case StoreKitError.userCancelled = error {
        invoke.resolve(["items": items])
      } else {
        invoke.reject("the App Store is not available", code: "UNAVAILABLE")
      }
      return
    }
    invoke.resolve(["items": items])
  }
}

extension MvNativePlugin {
  /// `storeProducts {}`: both subscriptions as the App Store offers them here.
  @objc public func storeProducts(_ invoke: Invoke) throws {
    guard #available(iOS 16.0, *) else {
      invoke.reject("needs iOS 16", code: "UNSUPPORTED")
      return
    }
    Task { await MvStore.products(invoke) }
  }

  /// `storePurchase {productId}`: the App Store's purchase sheet; answers once the sheet closed
  /// and a bought subscription was handed to the engine.
  @objc public func storePurchase(_ invoke: Invoke) throws {
    guard #available(iOS 16.0, *) else {
      invoke.reject("needs iOS 16", code: "UNSUPPORTED")
      return
    }
    guard let args = try? invoke.parseArgs(PurchaseArgs.self) else {
      invoke.reject("bad arguments", code: "INVALID")
      return
    }
    Task { await MvStore.purchase(args.productId, invoke) }
  }

  /// `storeRestore {}`: Restore Purchases.
  @objc public func storeRestore(_ invoke: Invoke) throws {
    guard #available(iOS 16.0, *) else {
      invoke.reject("needs iOS 16", code: "UNSUPPORTED")
      return
    }
    Task { await MvStore.restore(invoke) }
  }
}
