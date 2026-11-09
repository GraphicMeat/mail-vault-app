// MailVault mobile: Google Play subscriptions with Play Billing 7 (plan 4 Task 6). Called only
// from Rust (`storeProducts`, `storePurchase`, `storeRestore` on MvNativePlugin; see
// ../../../../src/store.rs), never from JS.
//
// Every purchase goes to the engine's `mobile.premium.verify` through the shell's
// `Store.nativeVerify` (../../../../../src/store.rs). Nothing is acknowledged here: the billing
// server acknowledges a purchase once it has accepted it (Play refunds one left unacknowledged for
// 3 days), so an unacknowledged purchase is one the server has not accepted yet. Those are handed
// over again whenever the plugin loads (a purchase the app was killed before verifying never
// reaches the listener), and the listener hands over any that complete while the app runs (a
// pending payment that went through). Only this install's own purchases go over automatically:
// one whose obfuscated account id is this install's. Another install's purchase on the same Play
// account would be refused by the server without `restore` and take this install's Premium with
// it; Restore is the way to bring those over.
//
// The purchase token never goes back to Rust's command reply or the page.

package com.mailvault.mvnative

import android.app.Activity
import android.util.Log
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.ProductDetails.RecurrenceMode
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.queryProductDetails
import com.android.billingclient.api.queryPurchasesAsync
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Locale
import kotlin.coroutines.resume

/** The product ids, the obfuscated account id and the shell's entry points. */
object Store {
    /** The two subscriptions, one base plan each (ledger Ruling P6). */
    val PRODUCT_IDS = listOf("com.mailvault.app.premium.monthly", "com.mailvault.app.premium.yearly")

    /** Play's obfuscated account id for an install: the SHA-256 of the lower-case install id, as 64
     *  lower-case hex digits (the server compares it the same way; Play allows 64 characters). */
    @JvmStatic
    fun obfuscatedId(installId: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(installId.lowercase(Locale.ROOT).toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { String.format(Locale.ROOT, "%02x", it.toInt() and 0xff) }
    }

    /** One purchase to the engine (`Java_com_mailvault_mvnative_Store_nativeVerify`): `json` is
     *  `{platform: "google", token, productId, restore?}`; answers `{answered, premium | code}`.
     *  Blocks: never on the main thread. */
    @JvmStatic
    external fun nativeVerify(json: String): String

    /** This install's id (`Java_com_mailvault_mvnative_Store_nativeInstallId`), "" when it cannot
     *  be had. Blocks: never on the main thread. */
    @JvmStatic
    external fun nativeInstallId(): String
}

/** The Play side of the plugin: one billing client for the activity's life. */
class StoreBilling(private val activity: Activity) : PurchasesUpdatedListener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client: BillingClient = BillingClient.newBuilder(activity.applicationContext)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .build()
    private val connecting = Mutex()
    private val lock = Any()
    @Volatile private var installId: String? = null
    /** The purchase sheet waiting for its result: the product it sells, and when it started. */
    private class Flow(val productId: String, val result: CompletableDeferred<Pair<BillingResult, List<Purchase>>>, val since: Long)
    private var flow: Flow? = null
    /** Tokens being handed over now: each goes over once at a time. */
    private val inFlight = mutableSetOf<String>()
    @Volatile private var started = false

    /** Hands over this install's purchases the server has not accepted yet. Once per plugin. */
    fun start() {
        if (started) return
        started = true
        scope.launch {
            val install = install() ?: return@launch
            if (connect().responseCode != BillingResponseCode.OK) return@launch
            val result = client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(ProductType.SUBS).build())
            if (result.billingResult.responseCode != BillingResponseCode.OK) return@launch
            handOver(result.purchasesList, install)
        }
    }

    private suspend fun install(): String? {
        installId?.let { return it }
        val id = withContext(Dispatchers.IO) {
            try { Store.nativeInstallId() } catch (e: Throwable) { "" }
        }
        if (id.isEmpty()) return null
        installId = id
        return id
    }

    private suspend fun connect(): BillingResult = connecting.withLock {
        if (client.isReady) return@withLock ok()
        suspendCancellableCoroutine { done ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (done.isActive) done.resume(result)
                }

                // The next call connects again.
                override fun onBillingServiceDisconnected() {}
            })
        }
    }

    private fun ok(): BillingResult = BillingResult.newBuilder().setResponseCode(BillingResponseCode.OK).build()

    private fun ourProduct(purchase: Purchase): String? = purchase.products.firstOrNull { it in Store.PRODUCT_IDS }

    /** One purchase to the engine; the reply as JSON. */
    private fun verify(purchase: Purchase, productId: String, restore: Boolean): JSONObject {
        val args = JSONObject().put("platform", "google").put("token", purchase.purchaseToken).put("productId", productId)
        if (restore) args.put("restore", true)
        return try {
            JSONObject(Store.nativeVerify(args.toString()))
        } catch (e: Throwable) {
            JSONObject().put("answered", false).put("code", "INTERNAL")
        }
    }

    /** This install's bought, unacknowledged purchases of ours, each once at a time. */
    private fun handOver(purchases: List<Purchase>, install: String) {
        val mine = Store.obfuscatedId(install)
        for (purchase in purchases) {
            val product = ourProduct(purchase) ?: continue
            if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED || purchase.isAcknowledged) continue
            if (purchase.accountIdentifiers?.obfuscatedAccountId != mine) continue
            val token = purchase.purchaseToken
            if (!synchronized(lock) { inFlight.add(token) }) continue
            try {
                val reply = verify(purchase, product, false)
                Log.i("MailVault", "MV_MOBILE {\"storeHandOver\":{\"answered\":${reply.optBoolean("answered")}}}")
            } finally {
                synchronized(lock) { inFlight.remove(token) }
            }
        }
    }

    // Play's listener: the result of the running purchase sheet, or purchases that changed while
    // the app runs (a pending payment that went through).
    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        val list = purchases?.toList() ?: emptyList()
        val waiting = synchronized(lock) {
            val f = flow
            val forFlow = f != null && (result.responseCode != BillingResponseCode.OK || list.any { f.productId in it.products })
            if (forFlow) flow = null
            if (forFlow) f else null
        }
        if (waiting != null) {
            waiting.result.complete(result to list)
        } else if (result.responseCode == BillingResponseCode.OK && list.isNotEmpty()) {
            scope.launch { install()?.let { handOver(list, it) } }
        }
    }

    private fun code(result: BillingResult): String = when (result.responseCode) {
        BillingResponseCode.ITEM_UNAVAILABLE -> "NOT_FOUND"
        BillingResponseCode.ITEM_ALREADY_OWNED -> "OWNED"
        BillingResponseCode.DEVELOPER_ERROR, BillingResponseCode.ERROR -> "INTERNAL"
        else -> "UNAVAILABLE"
    }

    private fun reject(invoke: Invoke, result: BillingResult) {
        invoke.reject("Google Play: ${result.responseCode}", code(result))
    }

    private suspend fun details(ids: List<String>): Pair<BillingResult, List<ProductDetails>> {
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(ids.map {
                QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(ProductType.SUBS).build()
            })
            .build()
        val result = client.queryProductDetails(params)
        return result.billingResult to (result.productDetailsList ?: emptyList())
    }

    /** The offer a purchase uses: an offer of the base plan this account is eligible for (Play lists
     *  only those) with an intro phase, else the base plan itself. */
    private fun offer(details: ProductDetails): ProductDetails.SubscriptionOfferDetails? {
        val offers = details.subscriptionOfferDetails ?: return null
        return offers.firstOrNull { it.offerId != null && it.pricingPhases.pricingPhaseList.size > 1 }
            ?: offers.firstOrNull { it.offerId == null }
            ?: offers.firstOrNull()
    }

    /** `{id, title, price, period, introOffer?}` of one product, from the offer a purchase uses. */
    private fun describe(details: ProductDetails): JSObject? {
        val phases = offer(details)?.pricingPhases?.pricingPhaseList ?: return null
        val base = phases.lastOrNull() ?: return null
        val item = JSObject()
            .put("id", details.productId)
            .put("title", details.name)
            .put("price", base.formattedPrice)
            .put("period", base.billingPeriod)
        val intro = phases.firstOrNull()?.takeIf { phases.size > 1 && it.recurrenceMode != RecurrenceMode.INFINITE_RECURRING }
        if (intro != null) {
            val mode = when {
                intro.priceAmountMicros == 0L -> "freeTrial"
                intro.recurrenceMode == RecurrenceMode.FINITE_RECURRING -> "payAsYouGo"
                else -> "payUpFront"
            }
            item.put(
                "introOffer",
                JSObject()
                    .put("price", intro.formattedPrice)
                    .put("period", intro.billingPeriod)
                    .put("paymentMode", mode)
                    .put("periodCount", maxOf(1, intro.billingCycleCount)),
            )
        }
        return item
    }

    fun products(invoke: Invoke) {
        scope.launch {
            try {
                val connected = connect()
                if (connected.responseCode != BillingResponseCode.OK) return@launch reject(invoke, connected)
                val (result, list) = details(Store.PRODUCT_IDS)
                if (result.responseCode != BillingResponseCode.OK) return@launch reject(invoke, result)
                val out = JSArray()
                list.mapNotNull { describe(it) }.forEach { out.put(it) }
                invoke.resolve(JSObject().put("products", out))
            } catch (e: Throwable) {
                invoke.reject(e.javaClass.simpleName, "INTERNAL")
            }
        }
    }

    fun purchase(invoke: Invoke, productId: String) {
        scope.launch {
            val waiting = CompletableDeferred<Pair<BillingResult, List<Purchase>>>()
            try {
                if (productId !in Store.PRODUCT_IDS) return@launch invoke.reject("not a MailVault product", "INVALID")
                val install = install() ?: return@launch invoke.reject("no install id", "INTERNAL")
                val connected = connect()
                if (connected.responseCode != BillingResponseCode.OK) return@launch reject(invoke, connected)
                val (result, list) = details(listOf(productId))
                if (result.responseCode != BillingResponseCode.OK) return@launch reject(invoke, result)
                val details = list.firstOrNull { it.productId == productId }
                val chosen = details?.let { offer(it) }
                if (details == null || chosen == null) return@launch invoke.reject("Google Play does not offer this", "NOT_FOUND")
                val params = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(
                        listOf(
                            BillingFlowParams.ProductDetailsParams.newBuilder()
                                .setProductDetails(details)
                                .setOfferToken(chosen.offerToken)
                                .build(),
                        ),
                    )
                    .setObfuscatedAccountId(Store.obfuscatedId(install))
                    .build()
                // A sheet whose result never came (its activity went for good) is given up after
                // the shell's own 10 minutes, as a cancel.
                val now = System.currentTimeMillis()
                val (free, lost) = synchronized(lock) {
                    val old = flow
                    if (old != null && now - old.since < STALE_MS) {
                        false to null
                    } else {
                        flow = Flow(productId, waiting, now)
                        true to old
                    }
                }
                lost?.result?.complete(BillingResult.newBuilder().setResponseCode(BillingResponseCode.USER_CANCELED).build() to emptyList())
                if (!free) return@launch invoke.reject("a purchase is already running", "BUSY")
                val launched = withContext(Dispatchers.Main) { client.launchBillingFlow(activity, params) }
                if (launched.responseCode != BillingResponseCode.OK) {
                    synchronized(lock) { if (flow?.result === waiting) flow = null }
                    return@launch if (launched.responseCode == BillingResponseCode.USER_CANCELED) {
                        invoke.resolve(outcome("cancelled", productId))
                    } else {
                        reject(invoke, launched)
                    }
                }
                val (answer, purchases) = waiting.await()
                when (answer.responseCode) {
                    BillingResponseCode.OK -> {
                        val bought = purchases.firstOrNull { productId in it.products }
                        val reply = when {
                            bought == null -> outcome("cancelled", productId)
                            bought.purchaseState == Purchase.PurchaseState.PURCHASED ->
                                outcome("purchased", productId).put("verify", verify(bought, productId, false))
                            // A slow payment: it goes over when it completes (listener or next launch).
                            else -> outcome("pending", productId)
                        }
                        invoke.resolve(reply)
                        val others = purchases.filter { it !== bought }
                        if (others.isNotEmpty()) handOver(others, install)
                    }
                    BillingResponseCode.USER_CANCELED -> invoke.resolve(outcome("cancelled", productId))
                    else -> reject(invoke, answer)
                }
            } catch (e: Throwable) {
                synchronized(lock) { if (flow?.result === waiting) flow = null }
                invoke.reject(e.javaClass.simpleName, "INTERNAL")
            }
        }
    }

    private companion object {
        const val STALE_MS = 10 * 60 * 1000L
    }

    private fun outcome(status: String, productId: String): JSObject =
        JSObject().put("status", status).put("platform", "google").put("productId", productId)

    /** Restore Purchases: every subscription of ours this Play account holds goes to the engine as
     *  a restore. `{items: [{platform, productId, verify}]}`. */
    fun restore(invoke: Invoke) {
        scope.launch {
            try {
                val connected = connect()
                if (connected.responseCode != BillingResponseCode.OK) return@launch reject(invoke, connected)
                val result = client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(ProductType.SUBS).build())
                if (result.billingResult.responseCode != BillingResponseCode.OK) return@launch reject(invoke, result.billingResult)
                val items = JSArray()
                for (purchase in result.purchasesList) {
                    val product = ourProduct(purchase) ?: continue
                    if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) continue
                    items.put(
                        JSObject()
                            .put("platform", "google")
                            .put("productId", product)
                            .put("verify", verify(purchase, product, true)),
                    )
                }
                invoke.resolve(JSObject().put("items", items))
            } catch (e: Throwable) {
                invoke.reject(e.javaClass.simpleName, "INTERNAL")
            }
        }
    }
}
