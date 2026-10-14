# R8 for the release build: smaller and faster app (Compose in particular), with the code that is
# reached by name kept as it is.

# Crash reports keep file and line numbers.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# The map page calls the app by method name (window.CdaApp.onMapClick, onSimulate, on3d, …).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# kotlinx.serialization: the serializers generated for the DTOs of the app.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class it.cdanet.cpeconfigurator.**$$serializer { *; }
-keepclassmembers class it.cdanet.cpeconfigurator.** { *** Companion; }
-keepclasseswithmembers class it.cdanet.cpeconfigurator.** { kotlinx.serialization.KSerializer serializer(...); }

# JSch (SSH to the CPEs and RouterOS): ciphers, key exchanges and MACs are loaded by class name.
-keep class com.jcraft.jsch.** { *; }
-dontwarn com.jcraft.jsch.**
-dontwarn org.bouncycastle.**
-dontwarn com.sun.jna.**
-dontwarn org.newsclub.**
-dontwarn org.apache.logging.log4j.**
-dontwarn org.slf4j.**
-dontwarn javax.naming.**
-dontwarn org.ietf.jgss.**
