// Execução reduzida e reconstrução dos encaixes; proveniência no objeto.
window.INTERLUDE_SEARCH_DEMO = {
  "names": [
    "Hotel",
    "Empire State",
    "Bryant Park",
    "The MET",
    "Central Park"
  ],
  "matrix": [
    [
      0,
      587,
      691,
      1504,
      1417
    ],
    [
      567,
      0,
      579,
      1549,
      1656
    ],
    [
      730,
      508,
      0,
      1824,
      1386
    ],
    [
      1834,
      959,
      1779,
      0,
      561
    ],
    [
      1271,
      1260,
      1235,
      521,
      0
    ]
  ],
  "construction": [
    {
      "insert": 1,
      "route": [
        0,
        1,
        0
      ],
      "cost": 1154,
      "delta": 1154,
      "choices": [
        {
          "delta": 1154,
          "position": 1,
          "route": [
            0,
            1,
            0
          ]
        }
      ]
    },
    {
      "insert": 2,
      "route": [
        0,
        2,
        1,
        0
      ],
      "cost": 1766,
      "delta": 612,
      "choices": [
        {
          "delta": 612,
          "position": 1,
          "route": [
            0,
            2,
            1,
            0
          ]
        },
        {
          "delta": 742,
          "position": 2,
          "route": [
            0,
            1,
            2,
            0
          ]
        }
      ]
    },
    {
      "insert": 4,
      "route": [
        0,
        4,
        2,
        1,
        0
      ],
      "cost": 3727,
      "delta": 1961,
      "choices": [
        {
          "delta": 1961,
          "position": 1,
          "route": [
            0,
            4,
            2,
            1,
            0
          ]
        },
        {
          "delta": 2138,
          "position": 2,
          "route": [
            0,
            2,
            4,
            1,
            0
          ]
        },
        {
          "delta": 2360,
          "position": 3,
          "route": [
            0,
            2,
            1,
            4,
            0
          ]
        }
      ]
    },
    {
      "insert": 3,
      "route": [
        0,
        3,
        4,
        2,
        1,
        0
      ],
      "cost": 4375,
      "delta": 648,
      "choices": [
        {
          "delta": 648,
          "position": 1,
          "route": [
            0,
            3,
            4,
            2,
            1,
            0
          ]
        },
        {
          "delta": 1065,
          "position": 2,
          "route": [
            0,
            4,
            3,
            2,
            1,
            0
          ]
        },
        {
          "delta": 2275,
          "position": 3,
          "route": [
            0,
            4,
            2,
            3,
            1,
            0
          ]
        },
        {
          "delta": 2816,
          "position": 4,
          "route": [
            0,
            4,
            2,
            1,
            3,
            0
          ]
        }
      ]
    }
  ],
  "search": [
    {
      "route": [
        0,
        3,
        4,
        2,
        1,
        0
      ],
      "cost": 4375,
      "best": 4375
    },
    {
      "route": [
        0,
        2,
        4,
        3,
        1,
        0
      ],
      "cost": 4124,
      "best": 4124
    },
    {
      "route": [
        0,
        4,
        2,
        3,
        1,
        0
      ],
      "cost": 6002,
      "best": 4124
    },
    {
      "route": [
        0,
        2,
        4,
        3,
        1,
        0
      ],
      "cost": 4124,
      "best": 4124
    },
    {
      "route": [
        0,
        4,
        3,
        1,
        2,
        0
      ],
      "cost": 4206,
      "best": 4124
    },
    {
      "route": [
        0,
        3,
        1,
        4,
        2,
        0
      ],
      "cost": 6084,
      "best": 4124
    },
    {
      "route": [
        0,
        1,
        3,
        4,
        2,
        0
      ],
      "cost": 4662,
      "best": 4124
    },
    {
      "route": [
        0,
        3,
        4,
        1,
        2,
        0
      ],
      "cost": 4634,
      "best": 4124
    },
    {
      "route": [
        0,
        4,
        3,
        1,
        2,
        0
      ],
      "cost": 4206,
      "best": 4124
    },
    {
      "route": [
        0,
        2,
        4,
        3,
        1,
        0
      ],
      "cost": 4124,
      "best": 4124
    },
    {
      "route": [
        0,
        4,
        2,
        3,
        1,
        0
      ],
      "cost": 6002,
      "best": 4124
    },
    {
      "route": [
        0,
        2,
        4,
        3,
        1,
        0
      ],
      "cost": 4124,
      "best": 4124
    }
  ],
  "provenance": {
    "date": "2026-10-20",
    "ortools": "9.10.4067",
    "source": "Recorte da matriz atual de três dias; índices [0, 37, 39, 31, 29]",
    "model": "Uma rota, quatro visitas obrigatórias, somente deslocamento; sem janelas, durações, exclusões ou preferências.",
    "firstSolution": "PARALLEL_CHEAPEST_INSERTION",
    "localSearch": "GUIDED_LOCAL_SEARCH",
    "timeLimitMs": 200,
    "construction": "Reconstrução didática dos encaixes mínimos, primeira rota conferida contra o OR-Tools.",
    "search": "Soluções aceitas de AddAtSolutionCallback; a animação usa as três primeiras."
  }
};
