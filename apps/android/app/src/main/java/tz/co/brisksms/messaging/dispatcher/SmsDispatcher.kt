package tz.co.brisksms.messaging.dispatcher

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telephony.SmsManager
import android.util.Log
import tz.co.brisksms.messaging.data.DispatchState
import tz.co.brisksms.messaging.data.SmsDispatchDao
import tz.co.brisksms.messaging.data.SmsDispatchEntity
import tz.co.brisksms.messaging.sim.SimManager

sealed class DispatchOutcome {
    data class Submitted(val dispatchId: String, val partsCount: Int, val simSlot: Int) : DispatchOutcome()
    data class Failed(val dispatchId: String, val reason: String) : DispatchOutcome()
    data class DuplicateIgnored(val dispatchId: String) : DispatchOutcome()
}

/**
 * Android Cellular SMS Dispatch Engine
 * Controls SmsManager operations, SIM subscription routing, and idempotency guarantees.
 * Non-negotiable invariant: Android is purely a transport relay. Prepaid credits are backend-managed.
 */
class SmsDispatcher(
    private val context: Context,
    private val simManager: SimManager = SimManager(context)
) {

    companion object {
        private const val TAG = "SmsDispatcher"
        const val ACTION_SMS_SENT = "tz.co.brisksms.SMS_SENT"
        const val ACTION_SMS_DELIVERED = "tz.co.brisksms.SMS_DELIVERED"
        const val EXTRA_DISPATCH_ID = "dispatch_id"
    }

    /**
     * Executes atomic SMS dispatch through designated SIM slot with idempotency guard
     */
    suspend fun dispatchMessage(
        dispatch: SmsDispatchEntity,
        dispatchDao: SmsDispatchDao
    ): DispatchOutcome {
        // 1. Idempotency check: prevent duplicate carrier transmission
        val existing = dispatchDao.findByIdempotencyKey(dispatch.idempotencyKey)
        if (existing != null && (existing.status == DispatchState.SUBMITTED.name || existing.status == DispatchState.DELIVERED.name)) {
            Log.w(TAG, "Idempotency trigger: Message [${dispatch.id}] already submitted. Skipping.")
            return DispatchOutcome.DuplicateIgnored(dispatch.id)
        }

        // 2. Resolve target SIM subscription
        val subId = simManager.resolveSubscriptionId(dispatch.simSlot)
        if (subId == null) {
            val err = "Designated SIM slot ${dispatch.simSlot} is absent or inactive"
            Log.e(TAG, err)
            dispatchDao.markFailed(dispatch.id, err)
            return DispatchOutcome.Failed(dispatch.id, err)
        }

        return try {
            val smsManager = getSmsManagerForSubId(subId)
            val parts = smsManager.divideMessage(dispatch.messageText)

            val sentIntents = ArrayList<PendingIntent>()
            val deliveryIntents = ArrayList<PendingIntent>()

            for (i in parts.indices) {
                val sentIntent = Intent(ACTION_SMS_SENT).apply {
                    putExtra(EXTRA_DISPATCH_ID, dispatch.id)
                    setPackage(context.packageName)
                }
                sentIntents.add(
                    PendingIntent.getBroadcast(
                        context,
                        dispatch.id.hashCode() + i,
                        sentIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                )

                val deliveryIntent = Intent(ACTION_SMS_DELIVERED).apply {
                    putExtra(EXTRA_DISPATCH_ID, dispatch.id)
                    setPackage(context.packageName)
                }
                deliveryIntents.add(
                    PendingIntent.getBroadcast(
                        context,
                        dispatch.id.hashCode() + i + 10000,
                        deliveryIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                )
            }

            dispatchDao.updateStatus(dispatch.id, DispatchState.DISPATCHING.name)

            if (parts.size > 1) {
                smsManager.sendMultipartTextMessage(
                    dispatch.recipientPhone,
                    null,
                    parts,
                    sentIntents,
                    deliveryIntents
                )
            } else {
                smsManager.sendTextMessage(
                    dispatch.recipientPhone,
                    null,
                    dispatch.messageText,
                    sentIntents.firstOrNull(),
                    deliveryIntents.firstOrNull()
                )
            }

            dispatchDao.updateStatus(dispatch.id, DispatchState.SUBMITTED.name, "cell_${System.currentTimeMillis()}")
            Log.i(TAG, "Successfully submitted SMS [${dispatch.id}] to SIM slot ${dispatch.simSlot} (${parts.size} parts)")
            DispatchOutcome.Submitted(dispatch.id, parts.size, dispatch.simSlot)
        } catch (e: SecurityException) {
            val err = "Missing SEND_SMS permission: ${e.message}"
            Log.e(TAG, err)
            dispatchDao.markFailed(dispatch.id, err)
            DispatchOutcome.Failed(dispatch.id, err)
        } catch (e: Exception) {
            val err = "Telephony dispatch exception: ${e.message}"
            Log.e(TAG, err)
            dispatchDao.markFailed(dispatch.id, err)
            DispatchOutcome.Failed(dispatch.id, err)
        }
    }

    private fun getSmsManagerForSubId(subId: Int): SmsManager {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(SmsManager::class.java).createForSubscriptionId(subId)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getSmsManagerForSubscriptionId(subId)
        }
    }
}
