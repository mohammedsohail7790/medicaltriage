using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading.Tasks;

// Gets a client-credentials token and reads the queue. .NET 8, no packages.
var baseUrl = Environment.GetEnvironmentVariable("BASE")!;
using var http = new HttpClient();

var form = new FormUrlEncodedContent(new Dictionary<string, string>
{
    ["grant_type"] = "client_credentials",
    ["client_id"] = Environment.GetEnvironmentVariable("CLIENT_ID")!,
    ["client_secret"] = Environment.GetEnvironmentVariable("CLIENT_SECRET")!,
});
var tokenResponse = await http.PostAsync($"{baseUrl}/api/v1/oauth/token", form);
tokenResponse.EnsureSuccessStatusCode();
var token = JsonDocument.Parse(await tokenResponse.Content.ReadAsStringAsync()).RootElement.GetProperty("access_token").GetString();

var request = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/api/v1/queue?limit=5");
request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
var queue = await http.SendAsync(request);
if ((int)queue.StatusCode == 429)
{
    Console.WriteLine($"Rate limited; retry after {queue.Headers.RetryAfter?.Delta?.TotalSeconds ?? 0} s");
    return;
}
Console.WriteLine($"{(int)queue.StatusCode} {await queue.Content.ReadAsStringAsync()}");
