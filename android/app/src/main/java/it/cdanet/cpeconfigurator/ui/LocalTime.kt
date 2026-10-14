package it.cdanet.cpeconfigurator.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val LOCAL_TIME = DateTimeFormatter.ofPattern("dd/MM/yy HH:mm")

/**
 * Date and time of a server instant in the phone's time zone ("" when missing). The server sends
 * UTC (`…Z`); a time without a zone is shown as it is.
 */
fun localTime(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String = iso?.let {
    runCatching { LOCAL_TIME.format(Instant.parse(it).atZone(zone)) }.getOrNull() ?: it.replace('T', ' ').take(16)
}.orEmpty()
