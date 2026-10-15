package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.PendingResult
import it.cdanet.cpeconfigurator.data.ProvisionResult
import it.cdanet.cpeconfigurator.data.ResultQueue
import it.cdanet.cpeconfigurator.data.Session
import it.cdanet.cpeconfigurator.data.SessionState
import it.cdanet.cpeconfigurator.data.UserDto
import it.cdanet.cpeconfigurator.field.RmaAnswer
import it.cdanet.cpeconfigurator.field.RmaQueue
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** The removed CPE of a replacement: said on the roof, sent when there is signal, after the result. */
class RmaFlowTest {
    private lateinit var server: MockWebServer
    private lateinit var dir: File
    private val seen = CopyOnWriteArrayList<String>()
    private val bodies = mutableMapOf<String, String>()
    @Volatile private var online = true
    @Volatile private var resultArrived = false

    private val session = Session().apply { set(SessionState("token-di-prova", UserDto(7, "tecnico", "installer"), "2099-01-01T00:00:00Z")) }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun api(): ApiClient {
        val http = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
        return ApiClient({ server.url("/").toString().trimEnd('/') }, session, "android/test", http)
    }

    @Before
    fun start() {
        dir = Files.createTempDirectory("cda-rma").toFile()
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (!online) return MockResponse().setResponseCode(503).setBody("""{"error":"offline"}""")
                val key = "${request.method} ${request.requestUrl!!.encodedPath}"
                seen += key
                bodies[key] = request.body.readUtf8()
                if (key.endsWith("/result")) resultArrived = true
                // the server knows the replacement only once its result has arrived
                if (key == "POST /api/field/rma" && !resultArrived) return MockResponse().setResponseCode(404).setBody("""{"error":"rma_not_found"}""")
                return MockResponse().setBody("""{"ok":true,"id":1}""")
            }
        }
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
        dir.deleteRecursively()
    }

    @Test
    fun theAnswerFromTheRoofArrivesAfterTheReplacementsResult() = runBlocking {
        val api = api()
        val results = ResultQueue(dir, api, session, scope)
        val rma = RmaQueue(dir, api, session, results, scope)
        online = false
        results.enqueue(PendingResult("job-new", ProvisionResult("success", listOf("ok")), "ROSSI MARIO"))
        rma.answer(RmaAnswer("job-new", "broken", "bruciata dopo il temporale"))
        rma.sync()
        assertEquals(1, RmaQueue(dir, api, session, results, scope).pending.value.size)
        online = true
        assertEquals(1, rma.sync())
        assertEquals(listOf("POST /api/provisioning/jobs/job-new/result", "POST /api/field/rma"), seen.toList())
        val body = Json.parseToJsonElement(bodies["POST /api/field/rma"]!!).jsonObject
        assertEquals("broken", body["condition"]!!.jsonPrimitive.content)
        assertEquals("bruciata dopo il temporale", body["note"]!!.jsonPrimitive.content)
        assertTrue(rma.pending.value.isEmpty())
        assertEquals("broken", rma.sent.value["job-new"])
    }

    @Test
    fun notAReplacementIsNotRetriedForever() = runBlocking {
        val api = api()
        val results = ResultQueue(dir, api, session, scope)
        val rma = RmaQueue(dir, api, session, results, scope)
        rma.answer(RmaAnswer("job-x", "working"))
        rma.sync()
        assertTrue(rma.pending.value.isEmpty())
    }
}
