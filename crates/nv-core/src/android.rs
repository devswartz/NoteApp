//! Android start-up: gives the certificate verifier (rustls-platform-verifier) its handles into the JVM.
//!
//! The Kotlin side is `object NotiveloCore { external fun initAndroid(context: Context) }` in package
//! `com.notivelo.core` (crates/nv-core/kotlin/NotiveloCore/src/main/kotlin/com/notivelo/core/NotiveloCore.kt);
//! the app calls it once from `Application.onCreate`, before any network call. Without it the first
//! TLS handshake panics ("Expect rustls-platform-verifier to be initialized").
use jni::errors::ThrowRuntimeExAndDefault;
use jni::jni_mangle;
use jni::objects::JObject;
use jni::EnvUnowned;

#[jni_mangle("com.notivelo.core.NotiveloCore")]
pub fn init_android<'caller>(
    mut unowned_env: EnvUnowned<'caller>,
    _this: JObject<'caller>,
    context: JObject<'caller>,
) {
    unowned_env
        .with_env(|env| rustls_platform_verifier::android::init_with_env(env, context))
        .resolve::<ThrowRuntimeExAndDefault>();
}
