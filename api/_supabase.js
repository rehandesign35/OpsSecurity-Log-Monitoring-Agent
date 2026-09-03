const PROJECT7_URL = process.env.PROJECT7_SUPABASE_URL;
const PROJECT7_KEY = process.env.PROJECT7_SUPABASE_SERVICE_KEY;

// This portfolio demo has no auth; a real deployment must lock these endpoints down.

function requireProject7Config() {
  if (!PROJECT7_URL || !PROJECT7_KEY) {
    throw new Error('Project 7 Supabase configuration is missing');
  }
}

function supabaseEndpoint(table) {
  requireProject7Config();
  return new URL(`/rest/v1/${table}`, PROJECT7_URL);
}

function supabaseHeaders(extra = {}) {
  requireProject7Config();
  return {
    apikey: PROJECT7_KEY,
    Authorization: `Bearer ${PROJECT7_KEY}`,
    ...extra,
  };
}

async function supabaseRequest(table, options = {}, params = {}) {
  const endpoint = supabaseEndpoint(table);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      endpoint.searchParams.set(key, value);
    }
  });

  const response = await fetch(endpoint, {
    ...options,
    headers: supabaseHeaders(options.headers),
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase HTTP ${response.status}: ${responseBody}`);
  }

  if (!responseBody) {
    return [];
  }

  try {
    return JSON.parse(responseBody);
  } catch (error) {
    throw new Error(`Invalid Supabase JSON response: ${error.message}`);
  }
}

function sendError(res, error) {
  console.error(error);
  res.status(500).json({ error: error.message || 'Internal server error' });
}

module.exports = {
  sendError,
  supabaseRequest,
};
