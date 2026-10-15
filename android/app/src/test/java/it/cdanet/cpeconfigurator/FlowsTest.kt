package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.DetectedDto
import it.cdanet.cpeconfigurator.data.PendingResult
import it.cdanet.cpeconfigurator.data.ProvisionResult
import it.cdanet.cpeconfigurator.data.ResultQueue
import it.cdanet.cpeconfigurator.data.Session
import it.cdanet.cpeconfigurator.data.SessionState
import it.cdanet.cpeconfigurator.data.UserDto
import it.cdanet.cpeconfigurator.field.AcceptanceCpe
import it.cdanet.cpeconfigurator.field.AcceptanceQueue
import it.cdanet.cpeconfigurator.field.AcceptanceRadio
import it.cdanet.cpeconfigurator.field.AcceptanceReport
import it.cdanet.cpeconfigurator.field.InternetTest
import it.cdanet.cpeconfigurator.install.RepointLookup
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * The main flows of the app against a local test server: the installation result and the
 * acceptance test saved offline and sent when back online (in order, nothing lost or sent
 * twice), and the CPE of a re-pointing found among one's own or handed over.
 */
class FlowsTest {
    private lateinit var server: MockWebServer
    private lateinit var dir: File
    private val seen = CopyOnWriteArrayList<String>()
    private val bodies = mutableMapOf<String, String>()

    /** What the server answers, by "METHOD /path" (without the query); 200 {} otherwise. */
    private val answers = mutableMapOf<String, MockResponse>()
    @Volatile private var online = true

    private val session = Session().apply { set(SessionState("token-di-prova", UserDto(7, "tecnico", "installer"), "2099-01-01T00:00:00Z")) }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun api(): ApiClient {
        val http = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
        return ApiClient({ server.url("/").toString().trimEnd('/') }, session, "android/test", http)
    }

    @Before
    fun start() {
        dir = Files.createTempDirectory("cda-flows").toFile()
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val key = "${request.method} ${request.requestUrl!!.encodedPath}"
                if (!online) return MockResponse().setResponseCode(503).setBody("""{"error":"offline"}""")
                seen += key + (request.requestUrl!!.queryParameter("type")?.let { " type=$it" } ?: "")
                bodies[key] = request.body.readUtf8()
                return answers[key] ?: MockResponse().setBody("{}")
            }
        }
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
        dir.deleteRecursively()
    }

    private fun report(kind: String? = null, testId: String? = null) = AcceptanceReport(
        verdict = "ok",
        measuredAt = "2026-10-15T18:00:00Z",
        samples = 10,
        cpe = AcceptanceCpe(),
        radio = AcceptanceRadio(signal = -58),
        internet = InternetTest(false),
        checks = emptyList(),
        cpeHeightM = 6.5,
        kind = kind,
        testId = testId,
    )

    private val jpeg = ByteArray(2048) { 7 }

    @Test
    fun anInstallationFinishedOfflineIsSentWhenBackOnline() = runBlocking {
        val api = api()
        val results = ResultQueue(dir, api, session, scope)
        results.enqueue(PendingResult("job-1", ProvisionResult("success", listOf("ok"), detected = DetectedDto()), "ROSSI MARIO"))
        online = false
        assertEquals(0, results.sync())
        // the app restarts: the queue is read back from its files
        val again = ResultQueue(dir, api, session, scope)
        assertEquals(1, again.pending.value.size)
        online = true
        assertEquals(1, again.sync())
        assertTrue(again.pending.value.isEmpty())
        assertEquals(listOf("POST /api/provisioning/jobs/job-1/result"), seen.toList())
    }

    @Test
    fun anAcceptanceTestFromTheRoofArrivesWholeAndInOrder() = runBlocking {
        val api = api()
        val results = ResultQueue(dir, api, session, scope)
        val queue = AcceptanceQueue(dir, api, session, results, scope)
        results.enqueue(PendingResult("job-1", ProvisionResult("success", listOf("ok")), "ROSSI MARIO"))
        online = false
        queue.enqueue("job-1", "ROSSI MARIO", report(), listOf(jpeg to "Antenna", jpeg.copyOf().also { it[0] = 1 } to "Router cliente"))
        queue.sync()
        assertTrue(queue.isPending("job-1"))
        // the second photo was already on the server (sent before the answer got lost)
        answers["POST /api/provisioning/jobs/job-1/photos"] = MockResponse().setResponseCode(201).setBody("""{"id":1}""")
        online = true
        val reopened = AcceptanceQueue(dir, api, session, results, scope)
        assertEquals(1, reopened.sync())
        assertTrue(reopened.pending.value.isEmpty())
        assertEquals(
            listOf(
                // the installation's result first, then the test, then its photos with their type
                "POST /api/provisioning/jobs/job-1/result",
                "PUT /api/provisioning/jobs/job-1/acceptance",
                "POST /api/provisioning/jobs/job-1/photos type=antenna",
                "POST /api/provisioning/jobs/job-1/photos type=router",
            ),
            seen.toList(),
        )
        assertNull(reopened.rejected.value["job-1"])
        // nothing left on the phone
        assertTrue(File(dir, "acceptance").listFiles { f -> f.name.endsWith(".jpg") }.isNullOrEmpty())
    }

    @Test
    fun aPhotoAlreadyOnTheServerIsNotSentAgainAndTheLimitIsSaid() = runBlocking {
        val api = api()
        val results = ResultQueue(dir, api, session, scope)
        val queue = AcceptanceQueue(dir, api, session, results, scope)
        answers["POST /api/provisioning/jobs/job-2/photos"] = MockResponse().setResponseCode(409).setBody("""{"error":"photo_duplicate","id":3}""")
        queue.enqueue("job-2", "BIANCHI ANNA", null, listOf(jpeg to "Antenna"))
        queue.sync()
        assertTrue("a duplicate is a photo already sent", queue.pending.value.isEmpty())
        assertNull(queue.rejected.value["job-2"])
        answers["POST /api/provisioning/jobs/job-2/photos"] = MockResponse().setResponseCode(409).setBody("""{"error":"too_many_photos","max":8}""")
        queue.enqueue("job-2", "BIANCHI ANNA", null, listOf(jpeg to "Altro"))
        queue.sync()
        assertTrue("the limit is not retried forever", queue.pending.value.isEmpty())
        assertTrue(queue.rejected.value["job-2"]!!.contains("Altro"))
    }

    @Test
    fun aRepointingTestCarriesItsKindAndId() = runBlocking {
        val api = api()
        val results = ResultQueue(dir, api, session, scope)
        val queue = AcceptanceQueue(dir, api, session, results, scope)
        queue.enqueue("job-3", "VERDI LUCA", report(kind = "repoint", testId = "6f1c2b8e-1d7a-4c1e-9a52-3f0f5c6b7a10"), emptyList())
        queue.sync()
        val body = Json.parseToJsonElement(bodies["PUT /api/provisioning/jobs/job-3/acceptance"]!!).jsonObject
        assertEquals("repoint", body["kind"]!!.jsonPrimitive.content)
        assertEquals("6f1c2b8e-1d7a-4c1e-9a52-3f0f5c6b7a10", body["testId"]!!.jsonPrimitive.content)
        // an installation's test: no kind (older servers would refuse the field)
        queue.enqueue("job-4", "NERI ANNA", report(), emptyList())
        queue.sync()
        assertTrue("kind" !in Json.parseToJsonElement(bodies["PUT /api/provisioning/jobs/job-4/acceptance"]!!).jsonObject)
    }

    private val job = """{"id":"job-9","createdAt":"2026-10-01T10:00:00Z","status":"success","model":"LiteBeam 5AC","mac":"AA:BB:CC:DD:EE:FF","serial":"S1","ssid":"CDA-NET-N2-D01","pppoeUser":"rossi.mario@cda-net.it"}"""

    @Test
    fun aRepointingFindsTheCpeOrHasItHandedOver() = runBlocking {
        val api = api()
        val macs = listOf("AA:BB:CC:DD:EE:FF")
        val here = it.cdanet.cpeconfigurator.data.CpeLocation(37.5681, 14.2796, 12.0, "gps")
        // the technician's own installation
        answers["GET /api/field/cpe"] = MockResponse().setBody("""{"job":$job}""")
        assertEquals(RepointLookup.Found(AppJson.decodeFromString(it.cdanet.cpeconfigurator.data.JobDto.serializer(), job), false), RepointLookup.find({ api.cpeJob(macs) }, { api.claimCpe(macs, here) }))
        // someone else's: handed over, with the phone's position
        answers["GET /api/field/cpe"] = MockResponse().setBody("""{"job":null}""")
        answers["POST /api/field/cpe/claim"] = MockResponse().setBody("""{"job":$job}""")
        val claimed = RepointLookup.find({ api.cpeJob(macs) }, { api.claimCpe(macs, here) })
        assertEquals(true, (claimed as RepointLookup.Found).claimed)
        val sent = Json.parseToJsonElement(bodies["POST /api/field/cpe/claim"]!!).jsonObject
        assertEquals(37.5681, sent["position"]!!.jsonObject["lat"]!!.jsonPrimitive.content.toDouble(), 1e-9)
        // too far from the customer's: said plainly, not «no Internet»
        answers["POST /api/field/cpe/claim"] = MockResponse().setResponseCode(403).setBody("""{"error":"too_far"}""")
        val far = RepointLookup.find({ api.cpeJob(macs) }, { api.claimCpe(macs, here) })
        assertTrue((far as RepointLookup.Refused).why.contains("lontano"))
        // a CPE installed before the app
        answers["POST /api/field/cpe/claim"] = MockResponse().setBody("""{"job":null}""")
        assertEquals(RepointLookup.Found(null, false), RepointLookup.find({ api.cpeJob(macs) }, { api.claimCpe(macs, here) }))
        // the customer's Wi-Fi without Internet: asked again later
        online = false
        assertEquals(RepointLookup.Unreachable, RepointLookup.find({ api.cpeJob(macs) }, { api.claimCpe(macs, here) }))
    }
}
