exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const type = params.type || 'candles';
  const interval = params.interval || '1h';
  const outputsize = params.outputsize || '100';
  const API_KEY = 'e02de9a60165478aaf1da8a7b2096e05';

  const url = type === 'quote'
    ? `https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${API_KEY}`
    : `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${outputsize}&apikey=${API_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
