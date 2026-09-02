require("dotenv").config({
  path: require("path").join(__dirname, "../.env"),
  quiet: true,
});


/* =========================================================
   카카오모빌리티 길찾기

   course.js의 estimateTravelMinutes는
   직선거리에 우회 계수를 곱한 어림값이다.
   탐색 단계에서는 그 어림값을 그대로 쓰고
   최종 코스의 구간만 이 파일로 다시 계산한다.

   탐색 루프는 조합을 수천 번 검사하므로
   그 안에서 API를 부르면 쿼터가 바로 소진된다.
========================================================= */

const DIRECTIONS_URL =
  "https://apis-navi.kakaomobility.com/v1/directions";


/*
 * 카카오모빌리티는 자동차 경로만 준다.
 *
 * transit: 자동차 시간을 대중교통 기준으로 보정
 * car:     받은 자동차 시간을 그대로 사용 (택시 등)
 */
const MODE =
  process.env.ROUTING_MODE === "car"
    ? "car"
    : "transit";


/*
 * 자동차 시간 → 대중교통 시간 보정
 *
 * 서울 기준으로 대중교통은 자동차보다
 * 대체로 1.3~1.5배 걸리고
 * 거기에 대기와 환승 시간이 더 붙는다.
 *
 * 실제 대중교통 API로 바꾸면 이 두 값은 필요 없다.
 */
const TRANSIT_FROM_CAR_RATIO = 1.35;

const TRANSIT_OVERHEAD_MINUTES = 8;


/*
 * 도보 판단 기준
 *
 * course.js와 같은 값을 쓴다.
 * 이 거리 안쪽은 API를 부르지 않는다.
 * 자동차 경로로 500m를 계산해 봐야
 * 걸어가는 시간과 아무 상관이 없다.
 */
const DETOUR_RATIO = 1.3;

const WALK_LIMIT_KM = 1.2;

const WALK_SPEED_KMH = 4.5;


/*
 * 초당 요청 제한을 피하기 위한 간격
 */
const REQUEST_INTERVAL_MS = 200;

const MAX_ATTEMPTS = 3;


/*
 * 캐시 좌표 반올림 자리수
 *
 * 소수점 4자리는 약 10m다.
 * 같은 장소를 여러 코스가 공유하므로
 * 이 정도만 반올림해도 호출이 꽤 줄어든다.
 */
const CACHE_PRECISION = 4;


/* =========================================================
   거리 계산

   course.js에도 같은 함수가 있지만
   course.js가 이 파일을 require 하므로
   반대로 가져오면 순환 참조가 된다.
========================================================= */

const EARTH_RADIUS_KM = 6371;


function toRadians(degree) {
  return (
    degree *
    Math.PI /
    180
  );
}


function haversineKm(from, to) {
  const dLat =
    toRadians(to.lat - from.lat);

  const dLng =
    toRadians(to.lng - from.lng);

  const a =
    Math.sin(dLat / 2) ** 2 +

    Math.cos(toRadians(from.lat)) *
    Math.cos(toRadians(to.lat)) *
    Math.sin(dLng / 2) ** 2;

  return (
    EARTH_RADIUS_KM *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}


function walkMinutes(km) {
  return Math.max(
    1,
    Math.round(
      km / WALK_SPEED_KMH * 60
    )
  );
}


function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}


/* =========================================================
   호출 준비 상태
========================================================= */

function isRoutingEnabled() {
  return Boolean(
    process.env.KAKAO_REST_KEY
  );
}


/* =========================================================
   구간 캐시

   서버가 살아 있는 동안만 유지한다.
   같은 코스의 같은 구간, 그리고
   대안 코스끼리 겹치는 구간을 걸러 준다.
========================================================= */

const legCache = new Map();


function cacheKey(from, to) {
  const round = (value) =>
    value.toFixed(CACHE_PRECISION);

  return [
    MODE,
    round(from.lat),
    round(from.lng),
    round(to.lat),
    round(to.lng),
  ].join("|");
}


function clearRoutingCache() {
  legCache.clear();
}


let apiCalls = 0;

let apiFailures = 0;


/*
 * 인증 실패는 코스마다 반복되므로
 * 한 번만 알린다.
 */
let authWarned = false;


function getRoutingStats() {
  return {
    mode: MODE,

    enabled:
      isRoutingEnabled(),

    cachedLegs:
      legCache.size,

    apiCalls,

    apiFailures,
  };
}


/*
 * 요청을 순서대로 흘려보내기 위한 큐
 *
 * 코스 여러 개를 동시에 보정하더라도
 * 카카오에는 REQUEST_INTERVAL_MS 간격으로 나간다.
 */
let requestChain = Promise.resolve();


function enqueue(task) {
  const result =
    requestChain.then(task);

  requestChain =
    result
      .catch(() => {})
      .then(
        () =>
          sleep(REQUEST_INTERVAL_MS)
      );

  return result;
}


/* =========================================================
   카카오모빌리티 자동차 길찾기 호출

   성공하면 { distanceKm, carMinutes }
   실패하면 null
========================================================= */

async function callKakaoDirections(from, to) {
  const url =
    new URL(DIRECTIONS_URL);

  /* 카카오는 경도,위도 순서다 */
  url.searchParams.set(
    "origin",
    `${from.lng},${from.lat}`
  );

  url.searchParams.set(
    "destination",
    `${to.lng},${to.lat}`
  );

  url.searchParams.set(
    "priority",
    "RECOMMEND"
  );


  for (
    let attempt = 0;
    attempt < MAX_ATTEMPTS;
    attempt++
  ) {
    let response;

    apiCalls += 1;

    try {
      response =
        await fetch(
          url,
          {
            headers: {
              Authorization:
                `KakaoAK ${process.env.KAKAO_REST_KEY}`,
            },
          }
        );
    } catch (error) {
      await sleep(500 + attempt * 500);
      continue;
    }


    /* 인증 실패는 다시 걸어도 똑같다 */
    if (
      response.status === 401 ||
      response.status === 403
    ) {
      apiFailures += 1;

      if (!authWarned) {
        authWarned = true;

        console.error(
          `카카오 길찾기 인증 실패 (${response.status}).` +
          " KAKAO_REST_KEY와 카카오모빌리티 서비스 활성화를 확인하세요." +
          " 이동시간은 추정값으로 대체합니다."
        );
      }

      return null;
    }


    /* 쿼터 초과나 서버 오류는 잠시 뒤 재시도 */
    if (!response.ok) {
      await sleep(500 + attempt * 500);
      continue;
    }


    let data;

    try {
      data = await response.json();
    } catch (error) {
      await sleep(500 + attempt * 500);
      continue;
    }


    const route =
      data.routes?.[0];


    /*
     * result_code가 0이 아니면 경로를 못 찾은 것이다.
     * 예를 들어 104는 출발지와 도착지가 너무 가까운 경우다.
     * 재시도해도 같으므로 바로 포기하고
     * 호출한 쪽에서 추정값으로 넘어가게 한다.
     */
    if (
      !route ||
      route.result_code !== 0
    ) {
      return null;
    }


    return {
      distanceKm:
        route.summary.distance / 1000,

      carMinutes:
        route.summary.duration / 60,
    };
  }


  apiFailures += 1;

  return null;
}


/* =========================================================
   구간 하나의 이동시간

   돌려주는 값

   minutes     이동시간(분)
   source      walk | kakao-transit | kakao-car | estimate
   distanceKm  실제 경로 거리 (추정이면 직선 보정 거리)
========================================================= */

async function getLegMinutes(from, to) {
  const straightKm =
    haversineKm(from, to) *
    DETOUR_RATIO;


  /*
   * 걸어갈 거리는 API를 부르지 않는다.
   */
  if (straightKm <= WALK_LIMIT_KM) {
    return {
      minutes:
        walkMinutes(straightKm),

      source: "walk",

      distanceKm:
        Number(straightKm.toFixed(2)),
    };
  }


  const key =
    cacheKey(from, to);


  /*
   * 캐시에는 결과가 아니라 Promise를 넣는다.
   *
   * 결과가 나온 뒤에 넣으면
   * 같은 구간을 동시에 물어본 요청이
   * 응답을 기다리는 동안 캐시를 못 보고
   * 카카오를 한 번 더 부르게 된다.
   */
  if (legCache.has(key)) {
    return legCache.get(key);
  }


  const pending =
    resolveLeg(from, to, straightKm);

  legCache.set(key, pending);


  /*
   * 실패해서 던지면 캐시에 남기지 않는다.
   */
  pending.catch(
    () =>
      legCache.delete(key)
  );

  return pending;
}


async function resolveLeg(
  from,
  to,
  straightKm
) {
  if (!isRoutingEnabled()) {
    return estimateLeg(straightKm);
  }


  const route =
    await enqueue(
      () =>
        callKakaoDirections(from, to)
    );

  return (
    route
      ? toLegResult(route)
      : estimateLeg(straightKm)
  );
}


function toLegResult(route) {
  if (MODE === "car") {
    return {
      minutes:
        Math.max(
          1,
          Math.round(route.carMinutes)
        ),

      source: "kakao-car",

      distanceKm:
        Number(
          route.distanceKm.toFixed(2)
        ),

      carMinutes:
        Math.round(route.carMinutes),
    };
  }


  return {
    minutes:
      Math.max(
        1,
        Math.round(
          route.carMinutes *
          TRANSIT_FROM_CAR_RATIO
        ) +
        TRANSIT_OVERHEAD_MINUTES
      ),

    source: "kakao-transit",

    distanceKm:
      Number(
        route.distanceKm.toFixed(2)
      ),

    carMinutes:
      Math.round(route.carMinutes),
  };
}


/*
 * API를 못 쓸 때 쓰는 값
 *
 * course.js의 estimateTravelMinutes와 같은 식이다.
 */
const TRANSIT_SPEED_KMH = 18;


function estimateLeg(km) {
  return {
    minutes:
      Math.round(
        km / TRANSIT_SPEED_KMH * 60
      ) +
      TRANSIT_OVERHEAD_MINUTES,

    source: "estimate",

    distanceKm:
      Number(km.toFixed(2)),
  };
}


module.exports = {
  MODE,
  TRANSIT_FROM_CAR_RATIO,
  TRANSIT_OVERHEAD_MINUTES,
  WALK_LIMIT_KM,

  isRoutingEnabled,
  getLegMinutes,
  clearRoutingCache,
  getRoutingStats,

  haversineKm,
};
