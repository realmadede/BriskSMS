package tz.co.brisksms.messaging.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import java.util.UUID

enum class DispatchState {
    RECEIVED,
    QUEUED,
    DISPATCHING,
    SUBMITTED,
    DELIVERED,
    FAILED,
    UNKNOWN
}

@Entity(tableName = "sms_dispatch_queue")
data class SmsDispatchEntity(
    @PrimaryKey
    val id: String = UUID.randomUUID().toString(),
    val organizationId: String,
    val campaignId: String? = null,
    val recipientPhone: String,
    val messageText: String,
    val simSlot: Int = 1,
    val idempotencyKey: String,
    val status: String = DispatchState.QUEUED.name,
    val providerMessageId: String? = null,
    val errorMessage: String? = null,
    val attempts: Int = 0,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis()
)

@Dao
interface SmsDispatchDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(entity: SmsDispatchEntity)

    @Query("SELECT * FROM sms_dispatch_queue WHERE status = 'QUEUED' ORDER BY createdAt ASC LIMIT :limit")
    suspend fun getPendingDispatches(limit: Int = 20): List<SmsDispatchEntity>

    @Query("SELECT * FROM sms_dispatch_queue WHERE idempotencyKey = :idempotencyKey LIMIT 1")
    suspend fun findByIdempotencyKey(idempotencyKey: String): SmsDispatchEntity?

    @Query("UPDATE sms_dispatch_queue SET status = :status, providerMessageId = :providerId, updatedAt = :now WHERE id = :id")
    suspend fun updateStatus(id: String, status: String, providerId: String? = null, now: Long = System.currentTimeMillis())

    @Query("UPDATE sms_dispatch_queue SET status = 'FAILED', errorMessage = :error, attempts = attempts + 1, updatedAt = :now WHERE id = :id")
    suspend fun markFailed(id: String, error: String, now: Long = System.currentTimeMillis())

    @Query("SELECT COUNT(*) FROM sms_dispatch_queue WHERE status = 'QUEUED'")
    suspend fun countPending(): Int

    @Query("SELECT COUNT(*) FROM sms_dispatch_queue WHERE status = 'DISPATCHING'")
    suspend fun countInFlight(): Int

    @Query("SELECT COUNT(*) FROM sms_dispatch_queue WHERE status IN ('SUBMITTED', 'DELIVERED') AND createdAt >= :sinceTimestamp")
    suspend fun countSentSince(sinceTimestamp: Long): Int

    @Query("SELECT COUNT(*) FROM sms_dispatch_queue WHERE status = 'DELIVERED' AND createdAt >= :sinceTimestamp")
    suspend fun countDeliveredSince(sinceTimestamp: Long): Int

    @Query("SELECT COUNT(*) FROM sms_dispatch_queue WHERE simSlot = :slot AND status IN ('SUBMITTED', 'DELIVERED') AND createdAt >= :sinceTimestamp")
    suspend fun countSlotSentSince(slot: Int, sinceTimestamp: Long): Int

    @Query("SELECT * FROM sms_dispatch_queue ORDER BY createdAt DESC LIMIT 20")
    suspend fun getRecentDispatches(): List<SmsDispatchEntity>
}
