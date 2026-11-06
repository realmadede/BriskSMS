package tz.co.brisksms.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey
import java.util.UUID

/**
 * Offline Payment Notification Evidence Entity
 * Stores incoming payment notifications locally in Room before reliable HTTPS upload.
 */
@Entity(tableName = "offline_payment_evidence")
data class OfflineEvidenceEntity(
    @PrimaryKey
    val id: String = UUID.randomUUID().toString(),
    val packageName: String,
    val senderAddress: String,
    val rawPayload: String,
    val simSlot: Int = 1,
    val deviceTimestamp: Long = System.currentTimeMillis(),
    val signature: String? = null,
    val isUploaded: Boolean = false,
    val uploadedAt: Long? = null,
    val retryCount: Int = 0,
    val createdAt: Long = System.currentTimeMillis()
)
