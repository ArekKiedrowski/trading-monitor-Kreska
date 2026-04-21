export default async function handler(req, res) {
  try {
    const { symbol, interval = "1h", outputsize = "100" } = req.query;

    if (!symbol) {
      return res.status(400).json({ status: "error", message: "Missing symbol" });
    }

    const apiKey = process.env.TWELVEDATA_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ status: "error", message: "Missing TWELVEDATA_API_KEY" });
    }

    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", outputsize);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("format", "JSON");

    const response = await fetch(url.toString());
    const data = await response.json();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message || "Proxy error"
    });
  }
}
