package tz.co.brisksms.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface EvidenceDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEvidence(evidence: OfflineEvidenceEntity)

    @Query("SELECT * FROM offline_payment_evidence WHERE isUploaded = 0 ORDER BY deviceTimestamp ASC LIMIT :limit")
    suspend fun getPendingEvidence(limit: Int = 50): List<OfflineEvidenceEntity>

    @Query("UPDATE offline_payment_evidence SET isUploaded = 1, uploadedAt = :uploadedAt WHERE id = :id")
    suspend fun markUploaded(id: String, uploadedAt: Long = System.currentTimeMillis())

    @Query("UPDATE offline_payment_evidence SET retryCount = retryCount + 1 WHERE id = :id")
    suspend fun incrementRetryCount(id: String)

    @Query("SELECT COUNT(*) FROM offline_payment_evidence WHERE isUploaded = 0")
    suspend fun countPending(): Int

    @Query("SELECT COUNT(*) FROM offline_payment_evidence WHERE createdAt >= :sinceTimestamp")
    suspend fun countCollectedSince(sinceTimestamp: Long): Int

    @Query("SELECT COUNT(*) FROM offline_payment_evidence WHERE isUploaded = 1 AND uploadedAt >= :sinceTimestamp")
    suspend fun countUploadedSince(sinceTimestamp: Long): Int

    @Query("SELECT * FROM offline_payment_evidence ORDER BY createdAt DESC LIMIT 20")
    suspend fun getRecentEvidence(): List<OfflineEvidenceEntity>

    @Query("DELETE FROM offline_payment_evidence WHERE isUploaded = 1")
    suspend fun clearUploadedEvidence(): Int
}
