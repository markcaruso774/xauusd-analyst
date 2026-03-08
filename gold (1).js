export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { type = 'candles', interval = '1h', outputsize = '100' } = req.query;
  const API_KEY = 'e02de9a60165478aaf1da8a7b2096e05';

  const url = type === 'quote'
    ? `https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${API_KEY}`
    : `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${outputsize}&apikey=${API_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
