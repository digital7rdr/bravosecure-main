# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html
#
# B-685 turned R8 (`android.enableMinifyInReleaseBuilds`) and resource shrinking
# ON. This file is what makes that safe. It is FORCE-ADDED to git (`android/` is
# gitignored) because it was lost once already: a regenerated `android/` folder
# put back the stock template, and the next `assembleRelease` died in
# `minifyReleaseWithR8` on the Stripe classes below. Keep it tracked.

# ── Shrink, but do NOT obfuscate ──────────────────────────────────────────────
# React Native resolves native modules, view managers and TurboModules by NAME
# at runtime, and Crashlytics stack traces are read by humans. Renaming buys a
# little size and costs both.
-dontobfuscate

# ── React Native / Reanimated ─────────────────────────────────────────────────
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# ── Stripe push provisioning ──────────────────────────────────────────────────
# `@stripe/stripe-react-native` references the OPTIONAL push-provisioning artifact
# (`com.stripe:stripe-android-issuing-push-provisioning`), which we do not ship —
# the app takes card payments, it does not push cards into a wallet. R8 treats
# those dangling references as ERRORS and fails the build, so they are declared
# expected here. These are exactly the lines R8 emits into
# `app/build/outputs/mapping/release/missing_rules.txt`.
-dontwarn com.stripe.android.pushProvisioning.PushProvisioningActivity$g
-dontwarn com.stripe.android.pushProvisioning.PushProvisioningActivityStarter$Args
-dontwarn com.stripe.android.pushProvisioning.PushProvisioningActivityStarter$Error
-dontwarn com.stripe.android.pushProvisioning.PushProvisioningActivityStarter
-dontwarn com.stripe.android.pushProvisioning.PushProvisioningEphemeralKeyProvider
