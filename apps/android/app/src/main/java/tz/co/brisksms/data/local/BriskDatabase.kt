package tz.co.brisksms.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [OfflineEvidenceEntity::class], version = 1, exportSchema = false)
abstract class BriskDatabase : RoomDatabase() {

    abstract fun evidenceDao(): EvidenceDao

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
