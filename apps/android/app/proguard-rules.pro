# ProGuard & R8 Full Mode configuration rules for BriskSMS Android Companion

# 1. Aggressive R8 Obfuscation & Repackaging
-repackageclasses 'o'
-allowaccessmodification
-overloadaggressively

# Keep annotations and exceptions, avoiding global generic Signature retention to minimize metadata hints
-keepattributes *Annotation*,Exceptions

# 2. Strip Verbose/Debug/Info Logging in Release (retain sanitized Log.w and Log.e for field diagnostics)
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
    public static int i(...);
}

# 3. Preserve Android OS Entry Points & Manifest Components
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.service.notification.NotificationListenerService

# 4. Preserve WorkManager Worker & CoroutineWorker Reflection Constructors
-keep public class * extends androidx.work.Worker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keep public class * extends androidx.work.CoroutineWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# 5. Preserve Room Database, Generated _Impl, Entities, and DAOs
-keep class * extends androidx.room.RoomDatabase {
    public <init>();
}
-keep class * extends androidx.room.RoomDatabase_Impl { *; }
-keep @androidx.room.Entity class * { *; }
-keep @androidx.room.Dao class * { *; }
-keepclassmembers class * {
    @androidx.room.Entity *;
    @androidx.room.Dao *;
}
-keep class tz.co.brisksms.data.local.** { *; }
-keep class tz.co.brisksms.messaging.data.** { *; }
-dontwarn androidx.room.paging.**

# 6. Networking, Gson & ML Kit / CameraX
-dontwarn okio.**
-dontwarn okhttp3.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
-dontwarn org.bouncycastle.**
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# 7. Keystore & Encrypted Local Storage
-keep class tz.co.brisksms.security.** { *; }
-keep class tz.co.brisksms.core.storage.** { *; }
-keepnames class javax.crypto.** { *; }
-keepnames class java.security.** { *; }
