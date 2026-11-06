package tz.co.brisksms.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import java.util.concurrent.TimeUnit

/**
 * Reliable Background Evidence Forwarding Worker
 * Employs WorkManager exponential backoff and network constraints to upload queued evidence.
 */
class EvidenceUploadWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    companion object {
        private const val TAG = "EvidenceUploadWorker"
        private const val BACKEND_URL = "https://api.brisksms.com/v1/ingestion/evidence"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    override suspend fun doWork(): Result {
        val db = BriskDatabase.getInstance(applicationContext)
        val dao = db.evidenceDao()

        val pendingList = dao.getPendingEvidence(limit = 25)
        if (pendingList.isEmpty()) {
            return Result.success()
        }

        var anyFailed = false

        for (evidence in pendingList) {
            val uploaded = uploadSingleEvidence(evidence)
            if (uploaded) {
                dao.markUploaded(evidence.id)
            } else {
                dao.incrementRetryCount(evidence.id)
                anyFailed = true
            }
        }

        return if (anyFailed) Result.retry() else Result.success()
    }

    private fun uploadSingleEvidence(evidence: OfflineEvidenceEntity): Boolean {
        return try {
            val prefs = applicationContext.getSharedPreferences("brisksms_config", Context.MODE_PRIVATE)
            val orgId = prefs.getString("organization_id", null) ?: "00000000-0000-0000-0000-000000000001"
            val deviceId = prefs.getString("device_id", null)

            val json = JSONObject().apply {
                put("organizationId", orgId)
                put("sourceType", "ANDROID_NOTIFICATION_RELAY")
                put("deviceId", deviceId)
                put("senderAddress", evidence.senderAddress)
                put("rawPayload", evidence.rawPayload)
                put("simSlot", evidence.simSlot)
                put("deviceTimestamp", evidence.deviceTimestamp)
                if (evidence.signature != null) {
                    put("signature", evidence.signature)
                }
            }

            val request = Request.Builder()
                .url(BACKEND_URL)
                .post(json.toString().toRequestBody(JSON_MEDIA_TYPE))
                .header("User-Agent", "BriskSMS-Android/1.0.0")
                .build()

            httpClient.newCall(request).execute().use { response ->
                if (response.isSuccessful || response.code == 409) {
                    // 200 OK or 409 Duplicate both acknowledge that evidence was processed
                    Log.i(TAG, "Uploaded evidence [${evidence.id}], status: ${response.code}")
                    true
                } else {
                    Log.w(TAG, "Upload failed for [${evidence.id}], HTTP: ${response.code}")
                    false
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Network exception uploading evidence [${evidence.id}]: ${e.message}")
            false
        }
    }
}
