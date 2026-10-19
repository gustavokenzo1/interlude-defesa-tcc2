// Recorte executado no OR-Tools; proveniência ao final do objeto.
window.INTERLUDE_SEARCH_DEMO = {
  "names": [
    "Hotel",
    "Empire State",
    "Saint Patrick",
    "The MET",
    "Central Park"
  ],
  "matrix": [
    [
      0,
      773,
      741,
      1929,
      1376
    ],
    [
      74,
      0,
      936,
      1761,
      2156
    ],
    [
      889,
      616,
      0,
      1051,
      1446
    ],
    [
      1675,
      1344,
      969,
      0,
      559
    ],
    [
      1394,
      1649,
      1274,
      519,
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
      "cost": 847,
      "delta": 847,
      "choices": [
        {
          "delta": 847,
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
      "cost": 1431,
      "delta": 584,
      "choices": [
        {
          "delta": 584,
          "position": 1,
          "route": [
            0,
            2,
            1,
            0
          ]
        },
        {
          "delta": 1751,
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
      "insert": 3,
      "route": [
        0,
        2,
        3,
        1,
        0
      ],
      "cost": 3210,
      "delta": 1779,
      "choices": [
        {
          "delta": 1779,
          "position": 2,
          "route": [
            0,
            2,
            3,
            1,
            0
          ]
        },
        {
          "delta": 2157,
          "position": 1,
          "route": [
            0,
            3,
            2,
            1,
            0
          ]
        },
        {
          "delta": 3362,
          "position": 3,
          "route": [
            0,
            2,
            1,
            3,
            0
          ]
        }
      ]
    },
    {
      "insert": 4,
      "route": [
        0,
        2,
        3,
        4,
        1,
        0
      ],
      "cost": 4074,
      "delta": 864,
      "choices": [
        {
          "delta": 864,
          "position": 3,
          "route": [
            0,
            2,
            3,
            4,
            1,
            0
          ]
        },
        {
          "delta": 914,
          "position": 2,
          "route": [
            0,
            2,
            4,
            3,
            1,
            0
          ]
        },
        {
          "delta": 1909,
          "position": 1,
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
          "delta": 3476,
          "position": 4,
          "route": [
            0,
            2,
            3,
            1,
            4,
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
        2,
        3,
        4,
        1,
        0
      ],
      "cost": 4074,
      "best": 4074
    },
    {
      "route": [
        0,
        4,
        3,
        2,
        1,
        0
      ],
      "cost": 3554,
      "best": 3554
    },
    {
      "route": [
        0,
        3,
        4,
        2,
        1,
        0
      ],
      "cost": 4452,
      "best": 3554
    },
    {
      "route": [
        0,
        4,
        3,
        2,
        1,
        0
      ],
      "cost": 3554,
      "best": 3554
    },
    {
      "route": [
        0,
        3,
        4,
        2,
        1,
        0
      ],
      "cost": 4452,
      "best": 3554
    },
    {
      "route": [
        0,
        4,
        3,
        2,
        1,
        0
      ],
      "cost": 3554,
      "best": 3554
    }
  ],
  "provenance": {
    "date": "2026-10-19",
    "ortools": "9.10.4067",
    "source": "Recorte da timeMatrix de data.js, entrada registrada de Nova Iorque",
    "model": "Uma rota, quatro visitas obrigatórias, custo apenas de deslocamento em segundos; sem janelas, durações, exclusões ou preferências",
    "firstSolution": "PARALLEL_CHEAPEST_INSERTION",
    "localSearch": "GUIDED_LOCAL_SEARCH",
    "timeLimitMs": 200,
    "construction": "Encaixes mínimos calculados sobre a matriz e primeira rota conferida contra o OR-Tools",
    "search": "Primeiras seis soluções aceitas registradas por AddAtSolutionCallback; a animação usa as três primeiras e retorna à melhor"
  }
};
