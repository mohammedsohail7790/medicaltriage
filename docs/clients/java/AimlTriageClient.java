import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Gets a client-credentials token and reads the queue. Java 17+, no dependencies. */
public class AimlTriageClient {
    public static void main(String[] args) throws Exception {
        String base = System.getenv("BASE");
        String form = "grant_type=client_credentials"
            + "&client_id=" + URLEncoder.encode(System.getenv("CLIENT_ID"), StandardCharsets.UTF_8)
            + "&client_secret=" + URLEncoder.encode(System.getenv("CLIENT_SECRET"), StandardCharsets.UTF_8);
        HttpClient http = HttpClient.newHttpClient();

        HttpResponse<String> tokenResponse = http.send(
            HttpRequest.newBuilder(URI.create(base + "/api/v1/oauth/token"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form)).build(),
            HttpResponse.BodyHandlers.ofString());
        Matcher m = Pattern.compile("\"access_token\"\\s*:\\s*\"([^\"]+)\"").matcher(tokenResponse.body());
        if (tokenResponse.statusCode() != 200 || !m.find()) {
            throw new IllegalStateException("Token request failed: " + tokenResponse.statusCode());
        }

        HttpResponse<String> queue = http.send(
            HttpRequest.newBuilder(URI.create(base + "/api/v1/queue?limit=5"))
                .header("Authorization", "Bearer " + m.group(1)).GET().build(),
            HttpResponse.BodyHandlers.ofString());
        if (queue.statusCode() == 429) {
            System.out.println("Rate limited; retry after " + queue.headers().firstValue("Retry-After").orElse("?") + " s");
            return;
        }
        System.out.println(queue.statusCode() + " " + queue.body());
    }
}
