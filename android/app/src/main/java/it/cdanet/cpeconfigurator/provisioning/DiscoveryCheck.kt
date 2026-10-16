package it.cdanet.cpeconfigurator.provisioning

import it.cdanet.cpeconfigurator.data.StockItemDto
import it.cdanet.cpeconfigurator.field.Check
import it.cdanet.cpeconfigurator.field.Verdict
import it.cdanet.cpeconfigurator.tools.UbntDevice

/**
 * What the Ubiquiti discovery says of the CPE on the phone's Wi-Fi before the configuration is
 * written: the model, whether it is the CPE of the label (its MAC among the CPE's interfaces), the
 * firmware, still factory or already configured, and whether it is in the installer's warehouse.
 */
object DiscoveryCheck {
    data class Result(
        val device: UbntDevice,
        val model: String?,
        val checks: List<Check>,
        /** The CPE is in the installer's warehouse: its MAC and serial from there (from the label). */
        val stock: StockItemDto?,
    )

    private fun macLong(m: String?) = m?.let { Validation.parseMac(it) }?.replace(":", "")?.toLongOrNull(16)

    /** The CPE's MACs: the label carries the LAN one, the discovery may give the wireless one (a few units apart). */
    fun sameDevice(d: UbntDevice, mac: String?): Boolean {
        val want = macLong(mac) ?: return false
        val have = (listOfNotNull(d.mac) + d.addresses.map { it.first }).mapNotNull { macLong(it) }
        return have.any { kotlin.math.abs(it - want) <= 3 }
    }

    fun evaluate(d: UbntDevice, labelMac: String, stock: List<StockItemDto>, targetFirmware: String = "8.7.4", replacedMac: String = ""): Result {
        val model = Validation.modelFromDiscovery(d.model, d.fullModel)
        val checks = buildList {
            // a replacement with the old CPE still on the Wi-Fi: the new one is to be connected
            if (replacedMac.isNotBlank() && sameDevice(d, replacedMac)) add(Check("CPE", Verdict.Bad, "è quella da sostituire ($replacedMac): collega la CPE nuova"))
            add(
                if (model != null) Check("Modello", Verdict.Ok, model)
                else Check("Modello", Verdict.Bad, "${d.fullModel ?: d.model ?: "sconosciuto"}: non è un modello supportato"),
            )
            if (labelMac.isNotBlank()) {
                add(
                    if (sameDevice(d, labelMac)) Check("MAC", Verdict.Ok, "coincide con l'etichetta")
                    else Check("MAC", Verdict.Bad, "la CPE collegata (${d.mac ?: "—"}) non è quella dell'etichetta ($labelMac)"),
                )
            }
            d.version?.let { v ->
                add(
                    if (v == targetFirmware) Check("Firmware", Verdict.Ok, v)
                    else Check("Firmware", Verdict.Warn, "$v: va portato a $targetFirmware (CPE collegata → Firmware)"),
                )
            }
            when (d.factoryDefault) {
                true -> add(Check("Configurazione", Verdict.Ok, "di fabbrica"))
                false -> add(Check("Configurazione", Verdict.Warn, "già configurata: verrà sovrascritta"))
                null -> Unit
            }
            d.hostname?.takeIf { d.factoryDefault != true && it.isNotBlank() }?.let { add(Check("Nome", Verdict.Info, it)) }
        }
        val inStock = stock.firstOrNull { sameDevice(d, it.mac) }
        return Result(d, model, checks, inStock)
    }
}
