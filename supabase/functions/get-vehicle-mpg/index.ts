const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders,
    })
  }

  try {
    const { year, make, model } = await req.json()

    if (!year || !make || !model) {
      return new Response(
        JSON.stringify({
          error: 'Year, make, and model are required.',
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        },
      )
    }

    const carApiToken = Deno.env.get('CARAPI_TOKEN')

    const params = new URLSearchParams({
      year: String(year),
      make: String(make).trim(),
      model: String(model).trim()
    })

    const headers: Record<string, string> = {
      Accept: 'application/json',
    }

    // A JWT is needed for subscribed/full CarAPI data.
    // The free demo dataset can work without this header.
    if (carApiToken?.trim()) {
      headers.Authorization = `Bearer ${carApiToken.trim()}`
    }

    const response = await fetch(
      `https://carapi.app/api/mileages/v2?${params.toString()}`,
      { headers },
    )

    const responseText = await response.text()

    console.log('CarAPI status:', response.status)
    console.log('CarAPI response:', responseText)

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          error: `CarAPI returned status ${response.status}.`,
          details: responseText,
        }),
        {
          status: 502,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        },
      )
    }

    let result: {
      data?: Array<{
        combined_mpg?: number
        epa_city_mpg?: number
        epa_highway_mpg?: number
        make?: string
        model?: string
        trim?: string
      }>
    }

    try {
      result = JSON.parse(responseText)
    } catch {
      throw new Error('CarAPI returned invalid JSON.')
    }

    const firstVehicle = result.data?.[0]

    if (!firstVehicle) {
      return new Response(
        JSON.stringify({
          error: `No MPG data found for ${year} ${make} ${model}.`,
          matches: result.data ?? [],
        }),
        {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        },
      )
    }

    if (
      typeof firstVehicle.combined_mpg !== 'number' ||
      firstVehicle.combined_mpg <= 0
    ) {
      return new Response(
        JSON.stringify({
          error: 'CarAPI found the vehicle but did not provide combined MPG.',
          vehicle: firstVehicle,
        }),
        {
          status: 422,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        },
      )
    }

    return new Response(
      JSON.stringify({
        mpg: firstVehicle.combined_mpg,
        cityMpg: firstVehicle.epa_city_mpg ?? null,
        highwayMpg: firstVehicle.epa_highway_mpg ?? null,
        make: firstVehicle.make ?? make,
        model: firstVehicle.model ?? model,
        trim: firstVehicle.trim ?? null,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      },
    )
  } catch (error) {
    console.error('get-vehicle-mpg error:', error)

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error.',
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      },
    )
  }
})