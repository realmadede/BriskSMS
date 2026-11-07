package tz.co.brisksms.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import tz.co.brisksms.messaging.data.SmsDispatchDao
import tz.co.brisksms.messaging.data.SmsDispatchEntity

@Database(entities = [OfflineEvidenceEntity::class, SmsDispatchEntity::class], version = 2, exportSchema = false)
abstract class BriskDatabase : RoomDatabase() {

    abstract fun evidenceDao(): EvidenceDao
    abstract fun smsDispatchDao(): SmsDispatchDao

    companion object {
        @Volatile
        private var INSTANCE: BriskDatabase? = null

        fun getInstance(context: Context): BriskDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    BriskDatabase::class.java,
                    "brisksms_relay.db"
                ).fallbackToDestructiveMigration().build()
                INSTANCE = instance
                instance
            }
        }
    }
}
