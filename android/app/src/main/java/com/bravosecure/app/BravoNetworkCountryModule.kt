package com.bravosecure.app

import android.content.Context
import android.telephony.TelephonyManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Physical-country reader for the emergency-services directory.
 *
 * The directory used to fall back to the phone's LOCALE when no GPS-geocoded
 * country was available — a LANGUAGE setting, not a location. A client standing
 * in Dubai on an "English (United Kingdom)" phone was offered UK numbers.
 *
 * `TelephonyManager` answers the question the locale cannot:
 *
 *  • `networkCountryIso` — the MCC of the operator the handset is CAMPED ON right
 *    now. It is the country the radio is physically in, including while roaming,
 *    and it is derived from the cell tower, so **a VPN cannot influence it** (no
 *    IP geolocation is involved anywhere in this feature). Empty with no service.
 *  • `simCountryIso` — the SIM's HOME country. Weaker: a German SIM roaming in
 *    Dubai still reads DE, so the resolver ranks it below the serving network and
 *    below any real location fix.
 *
 * Neither call requires a runtime permission, so this works when the user has
 * denied location — which is exactly when the old locale guess was doing damage.
 *
 * getName() MUST be "BravoNetworkCountry" — it is the key the JS wrapper looks
 * up: NativeModules.BravoNetworkCountry in src/screens/vbg/networkCountry.ts.
 *
 * NOTE: android/ is .gitignored — this file must be force-added (git add -f),
 * same as the other Bravo* modules, or compileReleaseKotlin breaks on a fresh
 * checkout (see MainActivity.kt header).
 */
class BravoNetworkCountryModule(private val reactCtx: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactCtx) {

  override fun getName(): String = "BravoNetworkCountry"

  /**
   * Resolves `{network, sim}` — each an upper-case ISO-3166 alpha-2 code or
   * null. NEVER rejects: an emergency surface must not depend on this call
   * succeeding, and the JS side treats every null as "ask the next source".
   */
  @ReactMethod
  fun getCountry(promise: Promise) {
    val out = Arguments.createMap()
    var network: String? = null
    var sim: String? = null
    try {
      val tm = reactCtx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      network = normalise(tm?.networkCountryIso)
      sim = normalise(tm?.simCountryIso)
    } catch (_: Throwable) {
      // No telephony (Wi-Fi-only tablet), a stripped ROM, or a SecurityException
      // on an OEM that guards the getter — all mean "unknown", never a failure.
    }
    out.putString("network", network)
    out.putString("sim", sim)
    promise.resolve(out)
  }

  /**
   * Android hands back "", "--", or occasionally a stale lower-case value here,
   * and a non-country string that reached the directory would pin the WRONG
   * emergency numbers. Only a clean two-letter alphabetic code survives.
   */
  private fun normalise(raw: String?): String? {
    val v = raw?.trim()?.uppercase() ?: return null
    return if (v.length == 2 && v.all { it in 'A'..'Z' }) v else null
  }
}
