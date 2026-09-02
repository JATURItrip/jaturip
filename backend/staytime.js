require("dotenv").config({
  path: require("path").join(__dirname, "../.env"),
  quiet: true,
});

const fs = require("fs");
const path = require("path");

const {
  getPoiTags,
} =
  require("./filter");


const BASE_URL =
  process.env.TOUR_API_BASE_URL ||
  "https://apis.data.go.kr/B551011/KorService2";


const POI_PATH =
  path.join(
    __dirname,
    "seoul-poi-enriched.json"
  );

const OUTPUT_PATH =
  path.join(
    __dirname,
    "seoul-poi-staytime.json"
  );

const SAMPLE_OUTPUT_PATH =
  path.join(
    __dirname,
    "seoul-poi-staytime.sample.json"
  );


/* =========================================================
   콘텐츠 유형별 소요시간 필드

   TourAPI detailIntro2는 콘텐츠 유형마다
   응답 필드 이름이 전부 다르다.

   여기 없는 유형(관광지 12, 레포츠 28, 숙박 32,
   쇼핑 38, 음식점 39)은 소요시간 필드 자체가
   스키마에 없으므로 API를 호출하지 않는다.
========================================================= */

const DETAIL_FIELDS = {
  "14": {
    field: "spendtime",
    source: "tourapi:spendtime",
    playField: null,
  },

  "15": {
    field: "spendtimefestival",
    source: "tourapi:spendtimefestival",
    playField: "playtime",
  },

  "25": {
    field: "taketime",
    source: "tourapi:taketime",
    playField: null,
  },
};


/* =========================================================
   카테고리 고정 체류시간

   공식 소요시간이 있는 POI는 서울 2130개 중 12개뿐이다.
   나머지는 filter.js의 CATEGORY_TAGS에서 나온
   environment | activityStyle 조합으로 값을 채운다.

   CATEGORY_TAGS는 environment나 activityStyle을
   둘 다 가지는 항목이 많아 조합이 하나로 확정되지 않는다.
   그런 경우를 mixed로 두어 9칸으로 만든다.
========================================================= */

const DEFAULT_STAY_MINUTES = {
  /* 실내에 머무는 곳: 카페, 찜질방, 도서관 */
  "indoor|staying": {
    minMinutes: 30,
    recommendedMinutes: 60,
    maxMinutes: 120,
  },

  /* 실내를 둘러보는 곳: 박물관, 미술관, 아쿠아리움 */
  "indoor|moving": {
    minMinutes: 45,
    recommendedMinutes: 90,
    maxMinutes: 150,
  },

  "indoor|mixed": {
    minMinutes: 40,
    recommendedMinutes: 75,
    maxMinutes: 130,
  },

  /* 야외에 머무는 곳: 공원, 강, 계곡 */
  "outdoor|staying": {
    minMinutes: 30,
    recommendedMinutes: 60,
    maxMinutes: 120,
  },

  /* 야외를 걷는 곳: 골목길, 숲, 성곽 */
  "outdoor|moving": {
    minMinutes: 40,
    recommendedMinutes: 75,
    maxMinutes: 150,
  },

  "outdoor|mixed": {
    minMinutes: 35,
    recommendedMinutes: 70,
    maxMinutes: 135,
  },

  "mixed|staying": {
    minMinutes: 30,
    recommendedMinutes: 60,
    maxMinutes: 120,
  },

  "mixed|moving": {
    minMinutes: 40,
    recommendedMinutes: 80,
    maxMinutes: 150,
  },

  "mixed|mixed": {
    minMinutes: 30,
    recommendedMinutes: 60,
    maxMinutes: 120,
  },
};


/* =========================================================
   콘텐츠 유형 오버라이드

   indoor|staying 1306개 중 1242개가
   음식점(1007) + 숙박(235)이다.

   식당과 호텔과 카페가 같은 값을 받으면
   조합 테이블이 의미를 잃으므로
   이 두 유형만 따로 처리한다.
========================================================= */

const CONTENT_TYPE_OVERRIDES = {
  /* 음식점: 관람이 아니라 식사 */
  "39": {
    minMinutes: 60,
    recommendedMinutes: 90,
    maxMinutes: 120,
    source: "category-default:meal",
  },

  /* 숙박: 코스 후보가 아니므로 체류시간을 두지 않는다 */
  "32": {
    minMinutes: null,
    recommendedMinutes: null,
    maxMinutes: null,
    source: "not-applicable",
  },
};


/* 체류시간으로 인정할 범위 */
const MIN_VALID_MINUTES = 5;
const MAX_VALID_MINUTES = 720;


/* =========================================================
   문자열 정규화
========================================================= */

function normalizeText(raw) {
  if (
    raw === undefined ||
    raw === null
  ) {
    return "";
  }

  return String(raw)
    /* HTML 줄바꿈과 태그 */
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")

    /* HTML 엔티티 */
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")

    /* 다양한 물결표를 하나로 통일

       TourAPI 실제 데이터에는 U+223C(∼)가 섞여 있다.
       "1∼2시간 정도" 같은 값이 여기 해당한다. */
    .replace(/[∼〜～–—]/g, "~")

    /* 폭 없는 공백, 전각 공백 */
    .replace(/[ 　​]/g, " ")

    .replace(/\s+/g, " ")
    .trim();
}


/* =========================================================
   소요시간 문자열 한 조각을 읽는다

   "1시간 30분" → 90
   "30분"       → 30
   "2시간"      → 120
   "1시간 반"   → 90
   "2"          → 단위 없음. 반대편 단위를 따라간다.
========================================================= */

function readDurationPart(text) {
  const hourMatch =
    text.match(/(\d+(?:\.\d+)?)\s*시간/);

  const minuteMatch =
    text.match(/(\d+)\s*분/);

  const hasHalf =
    /시간\s*반/.test(text);


  if (hourMatch || minuteMatch) {
    let minutes = 0;

    if (hourMatch) {
      minutes +=
        Math.round(
          Number(hourMatch[1]) * 60
        );
    }

    if (minuteMatch) {
      minutes +=
        Number(minuteMatch[1]);
    }

    /* "1시간 반"처럼 분 표기가 따로 없을 때만 30분을 더한다 */
    if (
      hasHalf &&
      !minuteMatch
    ) {
      minutes += 30;
    }

    return {
      minutes,
      unit:
        hourMatch
          ? "hour"
          : "minute",
    };
  }


  /* 단위 없이 숫자만 있는 경우

     "1~2시간"의 왼쪽 "1"이 여기 해당한다. */
  const numberMatch =
    text.match(/(\d+(?:\.\d+)?)/);

  if (numberMatch) {
    return {
      minutes: null,
      unit: null,
      number:
        Number(numberMatch[1]),
    };
  }


  return null;
}


/* 단위가 없던 숫자에 반대편 단위를 적용한다 */
function applyUnit(part, unit) {
  if (part.minutes !== null) {
    return part.minutes;
  }

  if (unit === "hour") {
    return Math.round(part.number * 60);
  }

  return Math.round(part.number);
}


function isValidMinutes(value) {
  return (
    Number.isFinite(value) &&
    value >= MIN_VALID_MINUTES &&
    value <= MAX_VALID_MINUTES
  );
}


/* =========================================================
   소요시간 문자열 → 분 단위

   성공: { minMinutes, recommendedMinutes, maxMinutes }
   실패: { rejected: "사유" }
========================================================= */

function parseStayTime(raw) {
  const text = normalizeText(raw);

  if (!text) {
    return {
      rejected: "empty",
    };
  }


  /* 운영시간이 소요시간 필드에 잘못 들어간 경우를 걸러낸다.

     실제 데이터 예:
     "월~금 09:00 ~ 22:00 / 토~일 09:00 ~ 18:00"

     이 가드가 없으면 9시간 체류로 계산된다. */
  if (/\d{1,2}\s*:\s*\d{2}/.test(text)) {
    return {
      rejected: "operating-hours",
    };
  }


  /* 숫자 사이의 하이픈만 물결표로 바꾼다.

     "월-금"처럼 요일을 잇는 하이픈은 건드리지 않는다. */
  const rangeText =
    text.replace(
      /(\d\s*(?:시간|분)?)\s*-\s*(\d)/g,
      "$1~$2"
    );


  const segments =
    rangeText
      .split("~")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);


  /* 범위 표기: "약 30분~1시간", "1~2시간 정도" */
  if (segments.length >= 2) {
    const left =
      readDurationPart(segments[0]);

    const right =
      readDurationPart(
        segments[segments.length - 1]
      );

    if (
      !left ||
      !right
    ) {
      return {
        rejected: "unparseable",
      };
    }


    /* 단위가 한쪽에만 있으면 반대편 단위를 따라간다 */
    const unit =
      left.unit ||
      right.unit;

    if (!unit) {
      return {
        rejected: "unparseable",
      };
    }


    const minMinutes =
      applyUnit(left, unit);

    const maxMinutes =
      applyUnit(right, unit);


    if (
      !isValidMinutes(minMinutes) ||
      !isValidMinutes(maxMinutes) ||
      minMinutes > maxMinutes
    ) {
      return {
        rejected: "out-of-range",
      };
    }


    /* 권장값은 가운데를 5분 단위로 반올림 */
    const recommendedMinutes =
      Math.round(
        (minMinutes + maxMinutes) / 2 / 5
      ) * 5;


    return {
      minMinutes,
      recommendedMinutes,
      maxMinutes,
    };
  }


  /* 단일값: "약 1시간 30분", "60분 내외", "2시간" */
  const single =
    readDurationPart(text);

  if (
    !single ||
    single.minutes === null
  ) {
    return {
      rejected: "unparseable",
    };
  }

  if (!isValidMinutes(single.minutes)) {
    return {
      rejected: "out-of-range",
    };
  }


  return {
    minMinutes: single.minutes,
    recommendedMinutes: single.minutes,
    maxMinutes: single.minutes,
  };
}


/* =========================================================
   운영 시간대 문자열 → 시각 구간 목록

   playtime은 소요시간이 아니라 행사 운영 시간대다.
   서울 축제 71건이 전부 "16:00~22:00" 형태였다.

   체류시간 계산에는 쓰지 않고 따로 보관한다.
========================================================= */

const TIME_RANGE_PATTERN =
  /(\d{1,2})\s*:\s*(\d{2})\s*~\s*(\d{1,2})\s*:\s*(\d{2})/g;

const SINGLE_TIME_PATTERN =
  /(\d{1,2})\s*:\s*(\d{2})/g;


function formatClock(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);

  /* 24:00 이후 표기를 쓰는 데이터가 있어 29시까지 허용한다 */
  if (
    !Number.isInteger(h) ||
    !Number.isInteger(m) ||
    h < 0 ||
    h > 29 ||
    m < 0 ||
    m > 59
  ) {
    return null;
  }

  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0")
  );
}


function parsePlayTime(raw) {
  /* 하이픈도 물결표로 통일해서 "09:00 - 22:00"을 잡는다 */
  const text =
    normalizeText(raw)
      .replace(/(\d\s*:\s*\d{2})\s*-\s*(\d{1,2}\s*:)/g, "$1~$2");

  if (!text) {
    return [];
  }


  const windows = [];
  const seen = new Set();


  function push(start, end) {
    const key = `${start}|${end}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    windows.push({
      start,
      end,
    });
  }


  /* 1. 시작~종료 구간을 먼저 모두 뽑는다 */
  let consumed = text;

  TIME_RANGE_PATTERN.lastIndex = 0;

  let match;

  while (
    (match = TIME_RANGE_PATTERN.exec(text)) !== null
  ) {
    const start =
      formatClock(match[1], match[2]);

    const end =
      formatClock(match[3], match[4]);

    if (
      start &&
      end
    ) {
      push(start, end);
    }

    /* 남은 문자열에서 지워 단독 시각과 겹치지 않게 한다 */
    consumed =
      consumed.replace(match[0], " ");
  }


  /* 2. 구간에 속하지 않은 단독 시각

     "20:00"처럼 시작 시각만 있는 경우 */
  SINGLE_TIME_PATTERN.lastIndex = 0;

  while (
    (match = SINGLE_TIME_PATTERN.exec(consumed)) !== null
  ) {
    const start =
      formatClock(match[1], match[2]);

    if (start) {
      push(start, null);
    }
  }


  return windows;
}


/* =========================================================
   POI의 조합 키

   filter.js의 getCombinationKey는 쓰지 않는다.
   그쪽은 스와이프 전용 보정이 섞여 있고
   조합이 모호하면 null을 반환한다.
========================================================= */

function resolveCombinationKey(poi) {
  const tags = getPoiTags(poi);

  if (!tags) {
    return "mixed|mixed";
  }


  const environment =
    tags.environment.length === 1
      ? tags.environment[0]
      : "mixed";

  const activityStyle =
    tags.activityStyle.length === 1
      ? tags.activityStyle[0]
      : "mixed";


  const key =
    `${environment}|${activityStyle}`;

  return (
    DEFAULT_STAY_MINUTES[key]
      ? key
      : "mixed|mixed"
  );
}


/* 공식값이 없을 때 적용할 고정값 */
function resolveDefaultStayTime(poi, combinationKey) {
  const override =
    CONTENT_TYPE_OVERRIDES[
      String(poi.contenttypeid)
    ];

  if (override) {
    return override;
  }


  return {
    ...DEFAULT_STAY_MINUTES[combinationKey],
    source: "category-default",
  };
}


/* =========================================================
   TourAPI detailIntro2 호출

   poi.js의 callTourApi는 재사용할 수 없다.
   초당 요청 제한에 걸리면 API가 response 없이
   OpenAPI_ServiceResponse 봉투를 돌려주는데
   그쪽은 이걸 형식 오류로 보고 그대로 죽는다.
========================================================= */

const REQUEST_INTERVAL_MS = 600;
const MAX_ATTEMPTS = 5;


function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}


async function callDetailIntro(
  contentId,
  contentTypeId
) {
  if (!process.env.TOUR_API_KEY) {
    throw new Error(
      "TOUR_API_KEY가 .env에 없습니다."
    );
  }


  const url =
    new URL(`${BASE_URL}/detailIntro2`);

  const query = {
    serviceKey:
      decodeURIComponent(
        process.env.TOUR_API_KEY
      ),

    MobileOS: "ETC",
    MobileApp: "Jaturip",
    _type: "json",
    contentId,
    contentTypeId,
  };

  for (
    const [key, value]
    of Object.entries(query)
  ) {
    url.searchParams.set(key, value);
  }


  for (
    let attempt = 0;
    attempt < MAX_ATTEMPTS;
    attempt++
  ) {
    let body;

    try {
      const response = await fetch(url);
      body = await response.text();
    } catch (error) {
      await sleep(1500 + attempt * 1000);
      continue;
    }


    let data;

    try {
      data = JSON.parse(body);
    } catch (error) {
      /* _type=json인데 XML 오류 문서가 오는 경우 */
      await sleep(1500 + attempt * 1000);
      continue;
    }


    /* 초당 요청 제한 등 게이트웨이 단계 오류 */
    if (data.OpenAPI_ServiceResponse) {
      await sleep(1500 + attempt * 1000);
      continue;
    }


    const resultCode =
      data.response?.header?.resultCode;

    if (resultCode !== "0000") {
      return {
        ok: false,

        error:
          `${resultCode} / ${data.response?.header?.resultMsg}`,
      };
    }


    return {
      ok: true,

      item:
        data.response?.body?.items?.item?.[0] ??
        {},
    };
  }


  return {
    ok: false,
    error: "요청 제한으로 재시도 초과",
  };
}


/* =========================================================
   POI 하나 → 체류시간 레코드
========================================================= */

function buildStayTimeRecord(poi, detail) {
  const contentTypeId =
    String(poi.contenttypeid);

  const spec =
    DETAIL_FIELDS[contentTypeId] ?? null;


  const rawText =
    spec && detail
      ? normalizeText(detail[spec.field])
      : "";


  const rawPlayText =
    spec?.playField && detail
      ? normalizeText(detail[spec.playField])
      : "";

  const operatingWindows =
    parsePlayTime(rawPlayText);


  const combinationKey =
    resolveCombinationKey(poi);


  let parsed = null;
  let rejectedReason = null;

  if (rawText) {
    const result =
      parseStayTime(rawText);

    if (result.rejected) {
      rejectedReason = result.rejected;
    } else {
      parsed = result;
    }
  }


  /* 공식값을 그대로 쓴다.
     입장/퇴장 여유시간은 더하지 않는다. */
  const times =
    parsed
      ? {
          ...parsed,
          source: spec.source,
        }
      : resolveDefaultStayTime(
          poi,
          combinationKey
        );


  return {
    contentId:
      String(poi.contentid),

    contentTypeId,

    title:
      poi.title ?? null,

    lclsSystm3:
      poi.lclsSystm3 ?? null,

    combinationKey,

    minMinutes:
      times.minMinutes,

    recommendedMinutes:
      times.recommendedMinutes,

    maxMinutes:
      times.maxMinutes,

    source:
      times.source,

    rawText:
      rawText || null,

    isOfficial:
      Boolean(parsed),

    rejectedReason,

    operatingWindows,

    /* 운영 시간대의 원본 문자열.

       "프로그램 별 상이"처럼 시각이 없는 값 때문에
       operatingWindows가 비는 경우를 구분하기 위해 남긴다. */
    rawPlayText:
      rawPlayText || null,

    /* detailIntro2를 실제로 조회했는지.
       증분 실행에서 빈 필드를 다시 부르지 않기 위한 표시 */
    detailFetched:
      Boolean(detail),

    collectedAt:
      new Date().toISOString(),
  };
}


/* =========================================================
   증분 판단

   이미 공식값을 얻었거나,
   조회는 했는데 값이 없거나 파싱에 실패한 POI는
   다시 API를 부르지 않는다.
========================================================= */

function shouldSkipDetail(existing) {
  if (!existing) {
    return false;
  }

  return Boolean(existing.detailFetched);
}


/* =========================================================
   전체 수집
========================================================= */

async function collectStayTimes(
  pois,
  options = {}
) {
  const {
    force = false,
    existing = new Map(),
    onProgress = null,
  } = options;


  const records = [];

  const stats = {
    total: 0,
    apiCalled: 0,
    apiFailed: 0,
    apiSkipped: 0,
    official: 0,
    rejected: {},
  };


  for (const poi of pois) {
    const contentId =
      String(poi.contentid);

    const contentTypeId =
      String(poi.contenttypeid);

    const spec =
      DETAIL_FIELDS[contentTypeId] ?? null;


    let detail = null;


    if (spec) {
      const previous =
        existing.get(contentId);

      if (
        !force &&
        shouldSkipDetail(previous)
      ) {
        /* 이전 결과를 그대로 재사용한다 */
        stats.apiSkipped++;
        stats.total++;

        if (previous.isOfficial) {
          stats.official++;
        }

        if (previous.rejectedReason) {
          stats.rejected[previous.rejectedReason] =
            (stats.rejected[previous.rejectedReason] ?? 0) + 1;
        }

        records.push(previous);
        continue;
      }


      const result =
        await callDetailIntro(
          contentId,
          contentTypeId
        );

      stats.apiCalled++;

      if (result.ok) {
        detail = result.item;
      } else {
        stats.apiFailed++;

        console.warn(
          `조회 실패: ${poi.title} (${contentId}) - ${result.error}`
        );
      }

      if (onProgress) {
        onProgress(
          stats.apiCalled,
          poi
        );
      }

      await sleep(REQUEST_INTERVAL_MS);
    }


    const record =
      buildStayTimeRecord(poi, detail);

    stats.total++;

    if (record.isOfficial) {
      stats.official++;
    }

    if (record.rejectedReason) {
      stats.rejected[record.rejectedReason] =
        (stats.rejected[record.rejectedReason] ?? 0) + 1;
    }

    records.push(record);
  }


  return {
    records,
    stats,
  };
}


/* =========================================================
   저장된 결과 읽기

   추천 코스 생성 단계에서 사용한다.
========================================================= */

function loadStayTimeMap(filePath = OUTPUT_PATH) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  const records =
    JSON.parse(
      fs.readFileSync(
        filePath,
        "utf-8"
      )
    );

  return new Map(
    records.map(
      (record) => [
        String(record.contentId),
        record,
      ]
    )
  );
}


/* =========================================================
   KOPIS / 서울 열린데이터광장 보완 (2단계)

   .env에 KOPIS_API_KEY와 SEOUL_OPEN_DATA_KEY가 없어
   아직 착수할 수 없다.

   키가 생기면 여기서 공연·행사 POI의
   isOfficial === false 레코드를 채운다.

   async function enrichFromKopis(records) { ... }
========================================================= */


/* =========================================================
   CLI
========================================================= */

function parseArgs(argv) {
  const options = {
    force: false,
    live: false,
    limit: null,
    type: null,
  };

  for (const arg of argv) {
    if (arg === "--force") {
      options.force = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg.startsWith("--limit=")) {
      options.limit =
        Number(arg.slice("--limit=".length));
    } else if (arg.startsWith("--type=")) {
      options.type =
        arg.slice("--type=".length);
    }
  }

  return options;
}


async function loadPois(options) {
  if (options.live) {
    const {
      loadAreaPois,
    } =
      require("./poi");

    console.log(
      "TourAPI에서 서울 POI를 새로 불러옵니다..."
    );

    const result =
      await loadAreaPois("서울");

    return result.pois;
  }


  return JSON.parse(
    fs.readFileSync(
      POI_PATH,
      "utf-8"
    )
  );
}


async function main() {
  const options =
    parseArgs(
      process.argv.slice(2)
    );


  /* --type이나 --limit이 있으면 부분 실행이다.
     본 파일을 덮어쓰지 않고 별도 샘플 파일에 쓴다. */
  const isSample =
    Boolean(
      options.type ||
      options.limit
    );

  const outputPath =
    isSample
      ? SAMPLE_OUTPUT_PATH
      : OUTPUT_PATH;


  console.log(
    "\n======================================"
  );

  console.log(
    "POI 체류시간 수집"
  );

  console.log(
    "======================================"
  );


  let pois =
    await loadPois(options);

  console.log(
    "전체 POI:",
    pois.length
  );


  if (options.type) {
    pois =
      pois.filter(
        (poi) =>
          String(poi.contenttypeid) ===
          options.type
      );

    console.log(
      `유형 ${options.type} 필터:`,
      pois.length
    );
  }


  if (options.limit) {
    pois =
      pois.slice(0, options.limit);

    console.log(
      "개수 제한:",
      pois.length
    );
  }


  const existing =
    options.force
      ? new Map()
      : loadStayTimeMap(OUTPUT_PATH);

  if (existing.size > 0) {
    console.log(
      "기존 레코드:",
      existing.size,
      "(증분 실행)"
    );
  }


  const apiTargets =
    pois.filter(
      (poi) =>
        DETAIL_FIELDS[
          String(poi.contenttypeid)
        ]
    ).length;

  console.log(
    "API 조회 대상:",
    apiTargets
  );

  console.log("");


  const {
    records,
    stats,
  } =
    await collectStayTimes(
      pois,
      {
        force: options.force,
        existing,

        onProgress: (count, poi) => {
          console.log(
            `조회 ${count}/${apiTargets}: ${poi.title}`
          );
        },
      }
    );


  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      records,
      null,
      2
    ),
    "utf-8"
  );


  /* 요약 */

  const bySource = {};

  for (const record of records) {
    bySource[record.source] =
      (bySource[record.source] ?? 0) + 1;
  }


  console.log(
    "\n======================================"
  );

  console.log(
    "수집 완료"
  );

  console.log(
    "======================================"
  );

  console.log(
    "총 레코드:",
    stats.total
  );

  console.log(
    "공식 소요시간:",
    stats.official
  );

  console.log(
    "API 호출:",
    stats.apiCalled,
    "| 재사용:",
    stats.apiSkipped,
    "| 실패:",
    stats.apiFailed
  );

  console.log(
    "\n출처별:"
  );

  for (
    const [source, count]
    of Object.entries(bySource)
      .sort((a, b) => b[1] - a[1])
  ) {
    console.log(
      ` ${source}: ${count}`
    );
  }


  if (
    Object.keys(stats.rejected).length > 0
  ) {
    console.log(
      "\n파싱 실패 사유:"
    );

    for (
      const [reason, count]
      of Object.entries(stats.rejected)
    ) {
      console.log(
        ` ${reason}: ${count}`
      );
    }
  }


  console.log(
    "\n저장:",
    outputPath
  );

  if (isSample) {
    console.log(
      "부분 실행이라 본 파일은 건드리지 않았습니다."
    );
  }
}


if (require.main === module) {
  main().catch((error) => {
    console.error("\n오류 발생:");
    console.error(error);
    process.exit(1);
  });
}


module.exports = {
  DEFAULT_STAY_MINUTES,
  CONTENT_TYPE_OVERRIDES,
  DETAIL_FIELDS,

  normalizeText,
  parseStayTime,
  parsePlayTime,
  resolveCombinationKey,
  buildStayTimeRecord,

  collectStayTimes,
  loadStayTimeMap,
};
