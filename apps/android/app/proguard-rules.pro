# ProGuard & R8 configuration rules for BriskSMS Android Companion

# AndroidX & Jetpack Compose
-keepattributes *Annotation*
-keepclassmembers class * {
    @androidx.room.Entity *;
    @androidx.room.Dao *;
}

# Retrofit & OkHttp
-dontwarn okio.**
-dontwarn retrofit2.**
-keep class retrofit2.** { *; }
-keepattributes Signature
-keepattributes Exceptions

# Gson & Serialization DTOs
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keep class tz.co.brisksms.**.data.** { *; }
-keep class tz.co.brisksms.payment.data.** { *; }
-keep class tz.co.brisksms.messaging.data.** { *; }

# Keystore & Cryptographic primitives
-keep class tz.co.brisksms.security.** { *; }
-keep class tz.co.brisksms.core.storage.** { *; }
