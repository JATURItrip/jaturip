const fs = require("fs");
const path = require("path");

const {
  CATEGORY_TAGS,
} =
  require("./filter");

const {
  loadStayTimeMap,
} =
  require("./staytime");

const {
  isRoutingEnabled,
  getLegMinutes,
  getRoutingStats,
} =
  require("./routing");


/* =========================================================
   MVP 추천 규칙

   1. 추천 장소는 최대 2곳
   2. 체류시간은 공식 정보가 있으면 그대로 사용하고
      없으면 카테고리 기본값, 그것도 없으면 60분
   3. 다음 일정 도착 전 15분을 여유시간으로 남긴다
   4. preferred 조합을 우선 추천하고
      preferred만으로 코스가 안 나오면 uncertain을 추가한다
   5. rejected 조합만 가진 장소는 후보에서 제거한다
   6. 운영시간은 확인된 정보만 적용하고
      정보가 없으면 일단 후보에 포함한다
   7. 이동시간 + 체류시간 + 여유시간 <= 전체 자투리 시간

   체류시간 조정, 장소별 학습, 가중치는 이후 개선 사항이다.
========================================================= */

const MAX_PLACES = 4;

const BUFFER_MINUTES = 15;

const FALLBACK_STAY_MINUTES = 60;


/*
 * 2곳 코스는 후보를 전부 조합하면
 * 경우의 수가 너무 많아지므로
 * 가까운 순으로 잘라서 탐색한다.
 *
 * 점수를 주는 것이 아니라
 * 탐색 범위만 제한하는 값이다.
 *
 * 1곳 코스는 후보 전체를 확인한다.
 */
const FIRST_STOP_POOL = 60;

const SECOND_STOP_POOL = 60;


/*
 * 대안 코스를 몇 개까지 함께 돌려줄지
 */
const ALTERNATIVE_COUNT = 2;


/*
 * 길찾기 API로 이동시간을 다시 계산할 코스 수
 *
 * 추정값으로 통과한 코스가 실제 이동시간에서는
 * 자투리 시간을 넘길 수 있다.
 * 그때 대신 내보낼 코스가 있어야 하므로
 * 최종 3개보다 넉넉하게 잡는다.
 *
 * 코스 하나당 구간은 최대 3개이고
 * 겹치는 구간은 routing.js가 캐시로 걸러 준다.
 */
const REFINE_POOL = 6;


const POI_PATH =
  path.join(
    __dirname,
    "seoul-poi-enriched.json"
  );


/* =========================================================
   거리와 이동시간

   여기 있는 추정은 탐색 단계에서만 쓴다.
   직선거리에 우회 계수를 곱한 어림값이다.

   탐색은 조합을 수천 번 검사하므로
   그 안에서 길찾기 API를 부를 수 없다.
   최종 후보로 남은 코스만 routing.js로
   실제 이동시간을 다시 계산한다.
========================================================= */

const EARTH_RADIUS_KM = 6371;

/* 직선거리 → 실제 경로 보정 */
const DETOUR_RATIO = 1.3;

/* 도보로 갈 만한 거리 */
const WALK_LIMIT_KM = 1.2;

const WALK_SPEED_KMH = 4.5;

/* 대중교통 평균 속도와 대기/환승 시간 */
const TRANSIT_SPEED_KMH = 18;

const TRANSIT_OVERHEAD_MINUTES = 8;


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


function estimateTravelMinutes(from, to) {
  const km =
    haversineKm(from, to) *
    DETOUR_RATIO;


  if (km <= WALK_LIMIT_KM) {
    return Math.max(
      1,
      Math.round(
        km / WALK_SPEED_KMH * 60
      )
    );
  }


  return (
    Math.round(
      km / TRANSIT_SPEED_KMH * 60
    ) +
    TRANSIT_OVERHEAD_MINUTES
  );
}


function toPoint(poi) {
  return {
    lat: Number(poi.mapy),
    lng: Number(poi.mapx),
  };
}


function isValidPoint(point) {
  return (
    Boolean(point) &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng)
  );
}


/* =========================================================
   시각 계산

   하루 안에서 분 단위로만 다룬다.
========================================================= */

function parseClock(text) {
  if (!text) {
    return null;
  }

  const match =
    String(text).match(
      /^(\d{1,2})\s*:\s*(\d{2})$/
    );

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    hour < 0 ||
    hour > 29 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return hour * 60 + minute;
}


function formatClock(minutes) {
  if (!Number.isFinite(minutes)) {
    return null;
  }

  const total =
    Math.round(minutes);

  const hour =
    Math.floor(total / 60) % 24;

  const minute =
    total % 60;

  return (
    String(hour).padStart(2, "0") +
    ":" +
    String(minute).padStart(2, "0")
  );
}


function nowClockMinutes() {
  const now = new Date();

  return (
    now.getHours() * 60 +
    now.getMinutes()
  );
}


/* =========================================================
   체류시간

   staytime.js가 만든 레코드를 그대로 쓴다.
   레코드가 없으면 60분으로 둔다.
========================================================= */

function resolveStayMinutes(poi, stayTimeMap) {
  const record =
    stayTimeMap.get(
      String(poi.contentid)
    );


  /*
   * 숙박처럼 코스 후보가 될 수 없는 유형
   */
  if (
    record &&
    record.source === "not-applicable"
  ) {
    return null;
  }


  if (
    record &&
    Number.isFinite(record.recommendedMinutes)
  ) {
    return record.recommendedMinutes;
  }


  return FALLBACK_STAY_MINUTES;
}


/* =========================================================
   운영시간

   확인된 정보가 있을 때만 적용한다.
   정보가 없으면 후보에 그대로 남긴다.

   확인된 경우에는 도착부터 체류 종료까지가
   운영 시간 안에 들어와야 한다.
========================================================= */

function hasOperatingInfo(record) {
  return Boolean(
    record &&
    Array.isArray(record.operatingWindows) &&
    record.operatingWindows.length > 0
  );
}


function fitsOperatingWindow(
  record,
  arriveAt,
  stayMinutes
) {
  if (!hasOperatingInfo(record)) {
    return true;
  }


  const leaveAt =
    arriveAt + stayMinutes;


  return record.operatingWindows.some(
    (window) => {
      const start =
        parseClock(window.start);

      /*
       * 종료 시각이 없는 데이터는
       * 시작 시각만 확인한다.
       */
      const end =
        parseClock(window.end);

      if (start === null) {
        return true;
      }

      if (arriveAt < start) {
        return false;
      }

      if (end === null) {
        return true;
      }

      return leaveAt <= end;
    }
  );
}


/* =========================================================
   취향 분류

   CATEGORY_TAGS는 environment와 activityStyle을
   둘 다 가질 수 있으므로
   장소 하나가 여러 조합에 걸린다.
========================================================= */

function toCombinationKey(combination) {
  return (
    combination.environment +
    "|" +
    combination.activityStyle
  );
}


function toKeySet(combinations) {
  const set = new Set();

  for (
    const combination
    of combinations ?? []
  ) {
    if (
      combination &&
      combination.environment &&
      combination.activityStyle
    ) {
      set.add(
        toCombinationKey(combination)
      );
    }
  }

  return set;
}


function getPossibleKeys(poi) {
  const tags =
    CATEGORY_TAGS[poi.lclsSystm3];

  if (!tags) {
    return [];
  }


  const keys = [];

  for (
    const environment
    of tags.environment
  ) {
    for (
      const activityStyle
      of tags.activityStyle
    ) {
      keys.push(
        environment +
        "|" +
        activityStyle
      );
    }
  }

  return keys;
}


/*
 * preferred / uncertain / excluded 중 하나로 분류
 *
 * - 가능한 조합이 전부 rejected면 제거
 * - rejected에 전혀 걸리지 않으면서
 *   preferred에 걸리면 우선 추천 대상
 * - 나머지는 uncertain
 */
function classifyCandidate(
  poi,
  preferredKeys,
  rejectedKeys
) {
  const keys =
    getPossibleKeys(poi);


  /*
   * 태그를 모르는 장소는 취향을 판단할 수 없다.
   * 제거하지 않고 uncertain으로 둔다.
   */
  if (keys.length === 0) {
    return "uncertain";
  }


  const rejectedHits =
    keys.filter(
      (key) => rejectedKeys.has(key)
    );

  if (
    rejectedHits.length === keys.length
  ) {
    return "excluded";
  }


  const preferredHits =
    keys.filter(
      (key) => preferredKeys.has(key)
    );

  if (
    preferredHits.length > 0 &&
    rejectedHits.length === 0
  ) {
    return "preferred";
  }


  return "uncertain";
}


/* =========================================================
   후보 목록 만들기
========================================================= */

function buildCandidates({
  pois,
  stayTimeMap,
  preferences,
}) {
  const preferredKeys =
    toKeySet(
      preferences?.preferred
    );

  /*
   * derivePreferences는 rejected라는 이름을 쓴다.
   * 프론트가 excluded로 보내는 경우도 받아준다.
   */
  const rejectedKeys =
    toKeySet(
      preferences?.rejected ??
      preferences?.excluded
    );


  const candidates = [];


  for (const poi of pois) {
    const point =
      toPoint(poi);

    if (!isValidPoint(point)) {
      continue;
    }


    const stayMinutes =
      resolveStayMinutes(
        poi,
        stayTimeMap
      );

    if (stayMinutes === null) {
      continue;
    }


    const tier =
      classifyCandidate(
        poi,
        preferredKeys,
        rejectedKeys
      );

    if (tier === "excluded") {
      continue;
    }


    const record =
      stayTimeMap.get(
        String(poi.contentid)
      ) ?? null;


    candidates.push({
      poi,
      point,
      stayMinutes,
      tier,
      record,
    });
  }


  return candidates;
}


/* =========================================================
   코스 만들기
========================================================= */

function makePlace(
  candidate,
  leg,
  arriveAt
) {
  const poi =
    candidate.poi;

  return {
    contentId:
      String(poi.contentid),

    title:
      poi.title,

    category:
      poi.lclsName?.level3 ??
      poi.lclsSystm3,

    address:
      poi.addr1 || null,

    image:
      poi.firstimage ||
      poi.firstimage2 ||
      null,

    lat:
      candidate.point.lat,

    lng:
      candidate.point.lng,

    tier:
      candidate.tier,

    travelMinutes:
      leg.minutes,

    /* estimate | walk | kakao-transit | kakao-car */
    travelSource:
      leg.source,

    travelDistanceKm:
      leg.distanceKm ?? null,

    stayMinutes:
      candidate.stayMinutes,

    arriveAt:
      formatClock(arriveAt),

    leaveAt:
      formatClock(
        arriveAt +
        candidate.stayMinutes
      ),

    /* 공식 소요시간을 쓴 장소인지 */
    stayIsOfficial:
      Boolean(
        candidate.record?.isOfficial
      ),

    staySource:
      candidate.record?.source ??
      "fallback:60",

    /* 운영시간을 실제로 확인한 장소인지 */
    operatingChecked:
      hasOperatingInfo(
        candidate.record
      ),
  };
}


/*
 * 구간 하나를 추정값으로 계산한다.
 *
 * routing.js가 돌려주는 것과 같은 모양이라
 * 두 값을 같은 자리에 넣을 수 있다.
 */
function estimateLeg(from, to) {
  return {
    minutes:
      estimateTravelMinutes(from, to),

    source: "estimate",

    distanceKm:
      Number(
        (
          haversineKm(from, to) *
          DETOUR_RATIO
        ).toFixed(2)
      ),
  };
}


/*
 * 코스가 지나는 구간 목록
 *
 * 출발지 → 장소들 → 도착지 순서다.
 * 시각과 무관하게 순서만으로 정해지므로
 * 추정이든 길찾기든 같은 목록을 쓴다.
 */
function sequenceLegs(sequence, context) {
  const points = [
    context.start,

    ...sequence.map(
      (candidate) =>
        candidate.point
    ),

    context.end,
  ];

  const legs = [];

  for (
    let index = 0;
    index < points.length - 1;
    index++
  ) {
    legs.push([
      points[index],
      points[index + 1],
    ]);
  }

  return legs;
}


/*
 * 후보 목록과 구간 이동시간으로
 * 코스 하나를 조립한다.
 *
 * 실행 조건을 못 채우면 null을 돌려준다.
 *
 * 추정값으로 만들 때와
 * 길찾기 결과로 다시 만들 때
 * 같은 검사를 거치게 하려고 따로 뺐다.
 */
function assembleCourse(
  sequence,
  legs,
  context
) {
  const {
    availableMinutes,
    departAt,
  } = context;


  let clock = departAt;

  let travelTotal = 0;

  let stayTotal = 0;

  const places = [];


  for (
    let index = 0;
    index < sequence.length;
    index++
  ) {
    const candidate =
      sequence[index];

    const leg =
      legs[index];

    const arriveAt =
      clock + leg.minutes;


    /*
     * 운영시간이 확인된 장소는
     * 도착 시각을 검사한다.
     */
    if (
      !fitsOperatingWindow(
        candidate.record,
        arriveAt,
        candidate.stayMinutes
      )
    ) {
      return null;
    }


    places.push(
      makePlace(
        candidate,
        leg,
        arriveAt
      )
    );

    travelTotal += leg.minutes;

    stayTotal += candidate.stayMinutes;

    clock =
      arriveAt +
      candidate.stayMinutes;
  }


  /* 마지막은 도착지로 돌아가는 구간 */
  const returnLeg =
    legs[legs.length - 1];

  travelTotal += returnLeg.minutes;


  const totalMinutes =
    travelTotal +
    stayTotal +
    BUFFER_MINUTES;


  /*
   * 실행 조건
   */
  if (
    totalMinutes > availableMinutes
  ) {
    return null;
  }


  const preferredCount =
    places.filter(
      (place) =>
        place.tier === "preferred"
    ).length;


  const course = {
    places,

    travelMinutes:
      travelTotal,

    stayMinutes:
      stayTotal,

    returnMinutes:
      returnLeg.minutes,

    returnSource:
      returnLeg.source,

    bufferMinutes:
      BUFFER_MINUTES,

    totalMinutes,

    leftoverMinutes:
      availableMinutes -
      totalMinutes,

    preferredCount,

    departAt:
      formatClock(departAt),

    arriveEndAt:
      formatClock(
        clock + returnLeg.minutes
      ),

    /*
     * 이 코스의 이동시간을 어디서 얻었는지
     *
     * routed    구간 하나 이상을 길찾기 API로 받았다
     * estimate  전부 추정값이다
     *
     * 도보 구간은 길찾기를 부르든 안 부르든
     * 같은 도보 속도 계산이므로 routed로 치지 않는다.
     * 그래야 API가 한 번도 안 통했을 때
     * routed라고 잘못 알리지 않는다.
     */
    travelBasis:
      [
        ...places.map(
          (place) =>
            place.travelSource
        ),

        returnLeg.source,
      ].some(
        (source) =>
          source.startsWith("kakao")
      )
        ? "routed"
        : "estimate",
  };


  /*
   * 길찾기로 다시 계산할 때 원본 후보가 필요하다.
   *
   * poi 원본까지 들고 있어서 응답에 나가면 안 되므로
   * JSON.stringify가 무시하도록 숨겨 둔다.
   */
  Object.defineProperty(
    course,
    "sequence",
    {
      value: sequence,
      enumerable: false,
    }
  );


  return course;
}


/*
 * 후보 목록으로 코스 하나를 만들어 본다.
 *
 * 탐색 단계이므로 추정값만 쓴다.
 */
function tryBuildCourse(
  sequence,
  context
) {
  const legs =
    sequenceLegs(
      sequence,
      context
    ).map(
      ([from, to]) =>
        estimateLeg(from, to)
    );

  return assembleCourse(
    sequence,
    legs,
    context
  );
}


/* =========================================================
   길찾기 보정

   탐색이 끝난 코스의 구간만
   카카오모빌리티 길찾기로 다시 계산한다.

   실제 이동시간이 추정보다 길어져서
   자투리 시간을 넘기면 null이 되고
   그 자리는 다음 코스가 대신 채운다.
========================================================= */

async function refineCourse(course, context) {
  const sequence =
    course.sequence;

  /*
   * sequence가 없는 코스는 보정할 수 없다.
   * 추정값 그대로 돌려준다.
   */
  if (!sequence) {
    return course;
  }


  const legs = [];

  for (
    const [from, to]
    of sequenceLegs(sequence, context)
  ) {
    legs.push(
      await getLegMinutes(from, to)
    );
  }


  return assembleCourse(
    sequence,
    legs,
    context
  );
}


/*
 * 상위 코스들을 길찾기로 다시 계산하고
 * 남은 것만 새로 정렬한다.
 */
async function refineCourses(
  courses,
  context,
  limit = REFINE_POOL
) {
  const refined = [];

  for (
    const course
    of courses.slice(0, limit)
  ) {
    const result =
      await refineCourse(
        course,
        context
      );

    if (result) {
      refined.push(result);
    }
  }


  return refined.sort(
    compareCourses
  );
}


/*
 * 코스 비교 기준
 *
 * 1. preferred가 많은 코스
 * 2. 이동시간 + 남는 시간이 적은 코스
 * 3. 이동시간이 짧은 코스
 *
 * 2번을 "남는 시간이 적은 코스"로 두면
 * 멀리 이동해서 잔여시간을 없앤 코스가 유리해진다.
 * 이동시간을 같이 더하면 그 이점이 사라진다.
 *
 * 실제로 이 값은
 * 자투리 시간 - 체류시간 - 여유시간과 같으므로
 * 장소에서 보낸 시간이 가장 긴 코스를 고르는 것과 같다.
 */
function wastedMinutes(course) {
  return (
    course.travelMinutes +
    course.leftoverMinutes
  );
}


function compareCourses(a, b) {
  if (
    a.preferredCount !==
    b.preferredCount
  ) {
    return (
      b.preferredCount -
      a.preferredCount
    );
  }


  const wastedA =
    wastedMinutes(a);

  const wastedB =
    wastedMinutes(b);

  if (wastedA !== wastedB) {
    return (
      wastedA -
      wastedB
    );
  }


  return (
    a.travelMinutes -
    b.travelMinutes
  );
}


/*
 * 같은 장소 조합이 여러 번 나오지 않도록
 */
function courseKey(course) {
  return course.places
    .map(
      (place) => place.contentId
    )
    .join(">");
}


function sortByTravelFrom(
  candidates,
  origin,
  limit
) {
  return candidates
    .map(
      (candidate) => ({
        candidate,

        travelMinutes:
          estimateTravelMinutes(
            origin,
            candidate.point
          ),
      })
    )
    .sort(
      (a, b) =>
        a.travelMinutes -
        b.travelMinutes
    )
    .slice(0, limit)
    .map(
      (item) => item.candidate
    );
}


function searchCourses(
  candidates,
  context
) {
  const courses = [];

  const seen = new Set();


  function push(course) {
    if (!course) {
      return;
    }

    const key =
      courseKey(course);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    courses.push(course);
  }


  /*
   * 출발지에서 가까운 순
   */
  const ordered =
    sortByTravelFrom(
      candidates,
      context.start,
      candidates.length
    );


  /*
   * 1곳 코스는 후보 전체를 확인한다.
   */
  for (const first of ordered) {
    push(
      tryBuildCourse(
        [first],
        context
      )
    );
  }


  if (MAX_PLACES < 2) {
    return courses.sort(
      compareCourses
    );
  }


  /*
   * 2곳 코스는 가까운 후보끼리만 조합한다.
   */
  for (
    const first
    of ordered.slice(0, FIRST_STOP_POOL)
  ) {
    const secondPool =
      sortByTravelFrom(
        candidates.filter(
          (candidate) =>
            candidate !== first
        ),
        first.point,
        SECOND_STOP_POOL
      );

    for (const second of secondPool) {
      push(
        tryBuildCourse(
          [first, second],
          context
        )
      );
    }
  }


  return courses.sort(
    compareCourses
  );
}


/* =========================================================
   추천 진입점
========================================================= */

function buildCourseList({
  pois,
  stayTimeMap,
  preferences = null,
  availableMinutes,
  start,
  end = null,
  departAt = null,
}) {
  if (
    !Number.isFinite(availableMinutes) ||
    availableMinutes <= 0
  ) {
    throw new Error(
      "자투리 시간(분)이 필요합니다."
    );
  }


  if (!isValidPoint(start)) {
    throw new Error(
      "현재 위치 좌표가 필요합니다."
    );
  }


  /*
   * 다음 일정 장소를 주지 않으면
   * 출발한 자리로 돌아온다고 본다.
   */
  const endPoint =
    isValidPoint(end)
      ? end
      : start;


  const departMinutes =
    parseClock(departAt) ??
    nowClockMinutes();


  const context = {
    start,
    end: endPoint,
    availableMinutes,
    departAt: departMinutes,
  };


  const candidates =
    buildCandidates({
      pois,
      stayTimeMap,
      preferences,
    });


  const preferredCandidates =
    candidates.filter(
      (candidate) =>
        candidate.tier === "preferred"
    );


  /*
   * 1단계: preferred만으로 만들어 본다.
   */
  let courses =
    searchCourses(
      preferredCandidates,
      context
    );

  let usedUncertain = false;


  /*
   * 2단계: preferred만으로 코스가 안 나오면
   *        uncertain까지 후보에 넣는다.
   */
  if (courses.length === 0) {
    courses =
      searchCourses(
        candidates,
        context
      );

    usedUncertain = true;
  }


  return {
    courses,
    context,
    usedUncertain,

    candidateCount:
      candidates.length,

    preferredCandidateCount:
      preferredCandidates.length,

    availableMinutes,
  };
}


/*
 * 탐색 결과를 응답 모양으로 정리한다.
 */
function formatResult(search, courses) {
  return {
    course:
      courses[0] ?? null,

    alternatives:
      courses.slice(
        1,
        1 + ALTERNATIVE_COUNT
      ),

    usedUncertain:
      search.usedUncertain,

    /*
     * 탐색에서 실행 조건을 통과한 코스 수
     *
     * 길찾기로 다시 계산하는 건 상위 몇 개뿐이므로
     * 보정한 코스 수(refinedCount)와는 다르다.
     */
    feasibleCount:
      search.courses.length,

    candidateCount:
      search.candidateCount,

    preferredCandidateCount:
      search.preferredCandidateCount,

    availableMinutes:
      search.availableMinutes,

    bufferMinutes:
      BUFFER_MINUTES,
  };
}


/*
 * 추정 이동시간만 쓰는 추천
 *
 * 네트워크를 타지 않으므로
 * 테스트와 오프라인 실행에 쓴다.
 */
function recommendCourse(options) {
  const search =
    buildCourseList(options);

  return {
    ...formatResult(
      search,
      search.courses
    ),

    travelBasis: "estimate",
  };
}


/*
 * 길찾기 API로 이동시간을 보정한 추천
 *
 * 탐색은 추정값으로 하고
 * 상위 REFINE_POOL개 코스만 다시 계산한다.
 *
 * 보정 뒤에 자투리 시간을 넘겨 탈락한 코스는
 * 다음 순위 코스가 대신한다.
 */
async function recommendCourseWithRouting(options) {
  const search =
    buildCourseList(options);


  /*
   * getRoutingStats는 프로세스가 뜬 뒤의 누적값이다.
   * 이번 요청에서 몇 번 불렀는지 보려고
   * 앞뒤 차이를 따로 계산한다.
   */
  const before =
    getRoutingStats();


  /*
   * 만들 수 있는 코스가 없으면
   * 길찾기를 부를 이유가 없다.
   */
  if (search.courses.length === 0) {
    return {
      ...formatResult(search, []),

      travelBasis: "estimate",

      routing:
        routingReport(before),
    };
  }


  const refined =
    await refineCourses(
      search.courses,
      search.context
    );


  /*
   * 보정한 코스가 전부 탈락하면
   * 추정값 코스라도 내보낸다.
   *
   * 실제 이동시간으로는 빠듯하다는 뜻이므로
   * travelBasis로 그 사실을 알린다.
   */
  const useEstimate =
    refined.length === 0;

  const courses =
    useEstimate
      ? search.courses
      : refined;


  return {
    ...formatResult(search, courses),

    /*
     * 실제로 길찾기 값이 들어간 코스인지는
     * 코스 자신이 알고 있다.
     */
    travelBasis:
      courses[0]?.travelBasis ??
      "estimate",

    refinedCount:
      refined.length,

    routing:
      routingReport(before),
  };
}


/*
 * 이번 요청에서 실제로 나간 호출 수
 *
 * 카운터가 프로세스 전역이라
 * 요청이 겹치면 다른 요청 몫까지 세어진다.
 * 정확한 과금 집계가 아니라
 * 개발 중에 대충 보는 값이다.
 */
function routingReport(before) {
  const after =
    getRoutingStats();

  return {
    mode:
      after.mode,

    enabled:
      after.enabled,

    /* 이번 요청 */
    apiCalls:
      after.apiCalls -
      before.apiCalls,

    apiFailures:
      after.apiFailures -
      before.apiFailures,

    /* 서버가 뜬 뒤 쌓인 구간 캐시 */
    cachedLegs:
      after.cachedLegs,
  };
}


/* =========================================================
   저장된 POI 읽기
========================================================= */

function loadPois(filePath = POI_PATH) {
  return JSON.parse(
    fs.readFileSync(
      filePath,
      "utf-8"
    )
  );
}


/* =========================================================
   CLI

   node backend/course.js --minutes=120 --lat=37.5665 --lng=126.9780
========================================================= */

function parseArgs(argv) {
  const options = {
    minutes: 120,
    lat: 37.5665,
    lng: 126.978,
    at: null,
    prefer: null,

    /* 길찾기 API로 이동시간을 보정할지 */
    routing: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--minutes=")) {
      options.minutes =
        Number(arg.slice("--minutes=".length));
    } else if (arg.startsWith("--lat=")) {
      options.lat =
        Number(arg.slice("--lat=".length));
    } else if (arg.startsWith("--lng=")) {
      options.lng =
        Number(arg.slice("--lng=".length));
    } else if (arg.startsWith("--at=")) {
      options.at =
        arg.slice("--at=".length);
    } else if (arg.startsWith("--prefer=")) {
      options.prefer =
        arg.slice("--prefer=".length);
    } else if (arg === "--routing") {
      options.routing = true;
    }
  }

  return options;
}


function printCourse(course, label) {
  if (!course) {
    console.log(
      `${label}: 없음`
    );

    return;
  }


  console.log(
    `\n${label}`
  );

  console.log(
    "--------------------------------------"
  );

  course.places.forEach(
    (place, index) => {
      console.log(
        `${index + 1}. ${place.title} (${place.category}) [${place.tier}]`
      );

      console.log(
        `   이동 ${place.travelMinutes}분 [${place.travelSource}]` +
        ` → ${place.arriveAt} 도착` +
        ` / 체류 ${place.stayMinutes}분 → ${place.leaveAt} 출발` +
        (place.stayIsOfficial ? " (공식)" : "")
      );
    }
  );

  console.log(
    `복귀 이동 ${course.returnMinutes}분 [${course.returnSource}]` +
    ` → ${course.arriveEndAt} 도착`
  );

  console.log(
    `이동 ${course.travelMinutes}분` +
    ` + 체류 ${course.stayMinutes}분` +
    ` + 여유 ${course.bufferMinutes}분` +
    ` = ${course.totalMinutes}분` +
    ` (남는 시간 ${course.leftoverMinutes}분)`
  );
}


async function main() {
  const options =
    parseArgs(
      process.argv.slice(2)
    );


  const pois =
    loadPois();

  const stayTimeMap =
    loadStayTimeMap();


  /*
   * --prefer=indoor|staying,outdoor|moving
   */
  const preferences =
    options.prefer
      ? {
          preferred:
            options.prefer
              .split(",")
              .map((key) => {
                const [
                  environment,
                  activityStyle,
                ] = key.trim().split("|");

                return {
                  environment,
                  activityStyle,
                };
              }),

          rejected: [],
          uncertain: [],
        }
      : null;


  /*
   * --routing을 주면 카카오모빌리티 길찾기로
   * 최종 코스의 이동시간을 다시 계산한다.
   */
  const recommend =
    options.routing
      ? recommendCourseWithRouting
      : recommendCourse;


  const result =
    await recommend({
      pois,
      stayTimeMap,
      preferences,

      availableMinutes:
        options.minutes,

      start: {
        lat: options.lat,
        lng: options.lng,
      },

      departAt:
        options.at,
    });


  console.log(
    "\n======================================"
  );

  console.log(
    "자투립 코스 추천"
  );

  console.log(
    "======================================"
  );

  console.log(
    "자투리 시간:",
    result.availableMinutes,
    "분"
  );

  console.log(
    "후보:",
    result.candidateCount,
    "| preferred 후보:",
    result.preferredCandidateCount
  );

  console.log(
    "가능한 코스:",
    result.feasibleCount,
    result.usedUncertain
      ? "(uncertain 포함)"
      : "(preferred만 사용)"
  );

  console.log(
    "이동시간 기준:",
    result.travelBasis === "routed"
      ? "카카오모빌리티 길찾기"
      : "직선거리 추정"
  );

  if (result.routing) {
    console.log(
      "길찾기 호출:",
      result.routing.apiCalls,
      "| 실패:",
      result.routing.apiFailures,
      "| 캐시:",
      result.routing.cachedLegs,
      `| 모드: ${result.routing.mode}`
    );
  }


  printCourse(
    result.course,
    "추천 코스"
  );


  result.alternatives.forEach(
    (course, index) => {
      printCourse(
        course,
        `대안 ${index + 1}`
      );
    }
  );

  console.log("");
}


if (require.main === module) {
  main().catch(
    (error) => {
      console.error(error);

      process.exit(1);
    }
  );
}


module.exports = {
  MAX_PLACES,
  BUFFER_MINUTES,
  FALLBACK_STAY_MINUTES,

  REFINE_POOL,

  haversineKm,
  estimateTravelMinutes,
  estimateLeg,
  sequenceLegs,
  parseClock,
  formatClock,

  resolveStayMinutes,
  fitsOperatingWindow,
  classifyCandidate,
  buildCandidates,

  wastedMinutes,
  compareCourses,

  assembleCourse,
  tryBuildCourse,
  refineCourse,
  refineCourses,

  buildCourseList,
  recommendCourse,
  recommendCourseWithRouting,

  loadPois,
};
