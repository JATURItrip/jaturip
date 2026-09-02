require("dotenv").config({
  path: require("path").join(__dirname, "../.env"),
  quiet: true,
});

const fs = require("fs");
const path = require("path");

const BASE_URL =
  "https://apis.data.go.kr/B551011/KorService2";


/* =========================================================
   TourAPI 공통 호출
========================================================= */

async function callTourApi(endpoint, params = {}) {
  if (!process.env.TOUR_API_KEY) {
    throw new Error("TOUR_API_KEY가 .env에 없습니다.");
  }

  const url = new URL(`${BASE_URL}/${endpoint}`);

  const serviceKey =
    decodeURIComponent(process.env.TOUR_API_KEY);

  const query = {
    serviceKey,
    MobileOS: "ETC",
    MobileApp: "Jaturip",
    _type: "json",
    numOfRows: 1000,
    pageNo: 1,
    ...params,
  };

  for (const [key, value] of Object.entries(query)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url);

  if (!response.ok) {
    const errorBody =
      await response.text();

    console.error("\nTourAPI 요청 실패");
    console.error("endpoint:", endpoint);
    console.error("HTTP Status:", response.status);
    console.error("응답 내용:", errorBody);

    throw new Error(
      `TourAPI HTTP 오류: ${response.status}`
    );
  }

  const data =
    await response.json();

  if (!data.response) {
    console.error(
      "예상하지 못한 응답:",
      data
    );

    throw new Error(
      "TourAPI 응답 형식이 예상과 다릅니다."
    );
  }

  const header =
    data.response.header;

  if (header.resultCode !== "0000") {
    throw new Error(
      `TourAPI 오류: ${header.resultCode} / ${header.resultMsg}`
    );
  }

  return data.response.body;
}


/* =========================================================
   서울 지역코드 조회
========================================================= */

async function findAreaCode(areaName) {
  const body =
    await callTourApi("areaCode2");

  const items =
    body.items?.item ?? [];

  const area = items.find(
    (item) =>
      item.name === areaName ||
      item.name.includes(areaName)
  );

  if (!area) {
    throw new Error(
      `${areaName} 지역 코드를 찾지 못했습니다.`
    );
  }

  return area.code;
}


/* =========================================================
   서울 POI 조회

   지금은 분석용으로 첫 100개만 사용
========================================================= */

async function getPois(areaCode) {
  const numOfRows = 100;

  // 1페이지 먼저 조회해서 전체 개수 확인
  const firstBody = await callTourApi(
    "areaBasedList2",
    {
      areaCode,
      arrange: "A",
      numOfRows,
      pageNo: 1,
    }
  );

  const firstItems =
    firstBody.items?.item ?? [];

  const totalCount =
    Number(firstBody.totalCount ?? 0);

  const totalPages =
    Math.ceil(totalCount / numOfRows);

  console.log("전체 페이지 수:", totalPages);

  const allItems = [...firstItems];


  // 2페이지부터 마지막 페이지까지 조회
  for (
    let pageNo = 2;
    pageNo <= totalPages;
    pageNo++
  ) {
    console.log(
      `POI 수집 중: ${pageNo}/${totalPages}`
    );

    const body = await callTourApi(
      "areaBasedList2",
      {
        areaCode,
        arrange: "A",
        numOfRows,
        pageNo,
      }
    );

    const items =
      body.items?.item ?? [];

    allItems.push(...items);
  }


  return {
    items: allItems,
    totalCount,
  };
}


/* =========================================================
   기존 cat 분류에서 고유 조합 추출
========================================================= */

function getUniqueCatCombinations(pois) {
  const map = new Map();

  for (const poi of pois) {
    if (!poi.cat1) {
      continue;
    }

    const key = [
      poi.contenttypeid,
      poi.cat1,
      poi.cat2,
      poi.cat3,
    ].join("|");

    if (!map.has(key)) {
      map.set(key, {
        contentTypeId:
          poi.contenttypeid,

        cat1:
          poi.cat1 || null,

        cat2:
          poi.cat2 || null,

        cat3:
          poi.cat3 || null,
      });
    }
  }

  return [...map.values()];
}


/* =========================================================
   신분류 lcls에서 고유 조합 추출
========================================================= */

function getUniqueLclsCombinations(pois) {
  const map = new Map();

  for (const poi of pois) {
    if (!poi.lclsSystm1) {
      continue;
    }

    const key = [
      poi.lclsSystm1,
      poi.lclsSystm2,
      poi.lclsSystm3,
    ].join("|");

    if (!map.has(key)) {
      map.set(key, {
        level1:
          poi.lclsSystm1 || null,

        level2:
          poi.lclsSystm2 || null,

        level3:
          poi.lclsSystm3 || null,
      });
    }
  }

  return [...map.values()];
}


/* =========================================================
   cat 카테고리 캐시

   같은 상위 분류를 계속 API 호출하지 않기 위함
========================================================= */

const cat1Cache = new Map();
const cat2Cache = new Map();
const cat3Cache = new Map();


async function getCat1Map(contentTypeId) {
  if (cat1Cache.has(contentTypeId)) {
    return cat1Cache.get(contentTypeId);
  }

  const body =
    await callTourApi(
      "categoryCode2",
      {
        contentTypeId,
      }
    );

  const items =
    body.items?.item ?? [];

  const map = new Map(
    items.map(
      (item) => [
        item.code,
        item.name,
      ]
    )
  );

  cat1Cache.set(
    contentTypeId,
    map
  );

  return map;
}


async function getCat2Map(
  contentTypeId,
  cat1
) {
  const cacheKey =
    `${contentTypeId}|${cat1}`;

  if (cat2Cache.has(cacheKey)) {
    return cat2Cache.get(cacheKey);
  }

  const body =
    await callTourApi(
      "categoryCode2",
      {
        contentTypeId,
        cat1,
      }
    );

  const items =
    body.items?.item ?? [];

  const map = new Map(
    items.map(
      (item) => [
        item.code,
        item.name,
      ]
    )
  );

  cat2Cache.set(
    cacheKey,
    map
  );

  return map;
}


async function getCat3Map(
  contentTypeId,
  cat1,
  cat2
) {
  const cacheKey =
    `${contentTypeId}|${cat1}|${cat2}`;

  if (cat3Cache.has(cacheKey)) {
    return cat3Cache.get(cacheKey);
  }

  const body =
    await callTourApi(
      "categoryCode2",
      {
        contentTypeId,
        cat1,
        cat2,
      }
    );

  const items =
    body.items?.item ?? [];

  const map = new Map(
    items.map(
      (item) => [
        item.code,
        item.name,
      ]
    )
  );

  cat3Cache.set(
    cacheKey,
    map
  );

  return map;
}


/* =========================================================
   cat 조합 하나를 한글 이름으로 변환
========================================================= */

async function resolveCatCombination(category) {
  const cat1Map =
    await getCat1Map(
      category.contentTypeId
    );

  let cat2Map =
    new Map();

  let cat3Map =
    new Map();


  if (category.cat1) {
    cat2Map =
      await getCat2Map(
        category.contentTypeId,
        category.cat1
      );
  }


  if (
    category.cat1 &&
    category.cat2
  ) {
    cat3Map =
      await getCat3Map(
        category.contentTypeId,
        category.cat1,
        category.cat2
      );
  }


  return {
    ...category,

    names: {
      cat1:
        cat1Map.get(category.cat1) ??
        null,

      cat2:
        cat2Map.get(category.cat2) ??
        null,

      cat3:
        cat3Map.get(category.cat3) ??
        null,
    },
  };
}


/* =========================================================
   lcls 카테고리 캐시
========================================================= */

let lcls1Cache = null;

const lcls2Cache =
  new Map();

const lcls3Cache =
  new Map();


async function getLcls1Map() {
  if (lcls1Cache) {
    return lcls1Cache;
  }

  const body =
    await callTourApi(
      "lclsSystmCode2"
    );

  const items =
    body.items?.item ?? [];

  lcls1Cache =
    new Map(
      items.map(
        (item) => [
          item.code,
          item.name,
        ]
      )
    );

  return lcls1Cache;
}


async function getLcls2Map(level1) {
  if (lcls2Cache.has(level1)) {
    return lcls2Cache.get(level1);
  }

  const body =
    await callTourApi(
      "lclsSystmCode2",
      {
        lclsSystm1: level1,
      }
    );

  const items =
    body.items?.item ?? [];

  const map =
    new Map(
      items.map(
        (item) => [
          item.code,
          item.name,
        ]
      )
    );

  lcls2Cache.set(
    level1,
    map
  );

  return map;
}


async function getLcls3Map(
  level1,
  level2
) {
  const cacheKey =
    `${level1}|${level2}`;

  if (lcls3Cache.has(cacheKey)) {
    return lcls3Cache.get(cacheKey);
  }

  const body =
    await callTourApi(
      "lclsSystmCode2",
      {
        lclsSystm1: level1,
        lclsSystm2: level2,
      }
    );

  const items =
    body.items?.item ?? [];

  const map =
    new Map(
      items.map(
        (item) => [
          item.code,
          item.name,
        ]
      )
    );

  lcls3Cache.set(
    cacheKey,
    map
  );

  return map;
}


/* =========================================================
   lcls 조합 한글 이름으로 변환
========================================================= */

async function resolveLclsCombination(category) {
  const level1Map =
    await getLcls1Map();

  let level2Map =
    new Map();

  let level3Map =
    new Map();


  if (category.level1) {
    level2Map =
      await getLcls2Map(
        category.level1
      );
  }


  if (
    category.level1 &&
    category.level2
  ) {
    level3Map =
      await getLcls3Map(
        category.level1,
        category.level2
      );
  }


  return {
    ...category,

    names: {
      level1:
        level1Map.get(
          category.level1
        ) ?? null,

      level2:
        level2Map.get(
          category.level2
        ) ?? null,

      level3:
        level3Map.get(
          category.level3
        ) ?? null,
    },
  };
}


/* =========================================================
   POI별 한글 카테고리 붙이기
========================================================= */

function enrichPois(
  pois,
  resolvedCats,
  resolvedLcls
) {
  const catMap =
    new Map();

  const lclsMap =
    new Map();


  for (const category of resolvedCats) {
    const key = [
      category.contentTypeId,
      category.cat1,
      category.cat2,
      category.cat3,
    ].join("|");

    catMap.set(
      key,
      category.names
    );
  }


  for (const category of resolvedLcls) {
    const key = [
      category.level1,
      category.level2,
      category.level3,
    ].join("|");

    lclsMap.set(
      key,
      category.names
    );
  }


  return pois.map((poi) => {
    const catKey = [
      poi.contenttypeid,
      poi.cat1,
      poi.cat2,
      poi.cat3,
    ].join("|");

    const lclsKey = [
      poi.lclsSystm1,
      poi.lclsSystm2,
      poi.lclsSystm3,
    ].join("|");


    return {
      ...poi,

      categoryName:
        catMap.get(catKey) ?? null,

      lclsName:
        lclsMap.get(lclsKey) ?? null,
    };
  });
}


/* =========================================================
   사람이 보기 좋게 터미널 출력
========================================================= */

function printResolvedCats(categories) {
  console.log(
    "\n======================================"
  );

  console.log(
    "기존 cat 카테고리"
  );

  console.log(
    "======================================"
  );


  categories.forEach(
    (category) => {
      console.log(
        `${category.contentTypeId} | ` +
        `${category.cat1} (${category.names.cat1}) → ` +
        `${category.cat2} (${category.names.cat2}) → ` +
        `${category.cat3} (${category.names.cat3})`
      );
    }
  );
}


function printResolvedLcls(categories) {
  console.log(
    "\n======================================"
  );

  console.log(
    "신분류 lcls 카테고리"
  );

  console.log(
    "======================================"
  );


  categories.forEach(
    (category) => {
      console.log(
        `${category.level1} (${category.names.level1}) → ` +
        `${category.level2} (${category.names.level2}) → ` +
        `${category.level3} (${category.names.level3})`
      );
    }
  );
}


/* =========================================================
   실행
========================================================= */

async function main() {
  console.log(
    "TourAPI 서울 카테고리 분석 시작\n"
  );


  /* 1. 서울 코드 조회 */

  const areaCode =
    await findAreaCode("서울");

  console.log(
    "서울 지역 코드:",
    areaCode
  );


  /* 2. POI 100개 조회 */

  const result =
    await getPois(areaCode);

  const pois =
    result.items;

  console.log(
    "서울 전체 POI:",
    result.totalCount
  );

  console.log(
    "현재 분석 POI:",
    pois.length
  );


  /* 3. 고유 카테고리 조합 */

  const uniqueCats =
    getUniqueCatCombinations(
      pois
    );

  const uniqueLcls =
    getUniqueLclsCombinations(
      pois
    );

  console.log(
    "고유 cat 조합:",
    uniqueCats.length
  );

  console.log(
    "고유 lcls 조합:",
    uniqueLcls.length
  );


  /* 4. 기존 cat 한글 변환 */

  const resolvedCats = [];

  for (const category of uniqueCats) {
    const resolved =
      await resolveCatCombination(
        category
      );

    resolvedCats.push(
      resolved
    );
  }


  /* 5. lcls 한글 변환 */

  const resolvedLcls = [];

  for (const category of uniqueLcls) {
    const resolved =
      await resolveLclsCombination(
        category
      );

    resolvedLcls.push(
      resolved
    );
  }


  /* 6. 터미널 출력 */

  printResolvedCats(
    resolvedCats
  );

  printResolvedLcls(
    resolvedLcls
  );


  /* 7. POI에 한글 카테고리 붙이기 */

  const enrichedPois =
    enrichPois(
      pois,
      resolvedCats,
      resolvedLcls
    );


  /* 8. 파일 저장 */

  const categoryPath =
    path.join(
      __dirname,
      "seoul-category-summary.json"
    );

  const poiPath =
    path.join(
      __dirname,
      "seoul-poi-enriched.json"
    );


  fs.writeFileSync(
    categoryPath,
    JSON.stringify(
      {
        cat:
          resolvedCats,

        lcls:
          resolvedLcls,
      },
      null,
      2
    ),
    "utf-8"
  );


  fs.writeFileSync(
    poiPath,
    JSON.stringify(
      enrichedPois,
      null,
      2
    ),
    "utf-8"
  );


  console.log(
    "\n======================================"
  );

  console.log(
    "분석 완료"
  );

  console.log(
    "======================================"
  );

  console.log(
    "카테고리:",
    categoryPath
  );

  console.log(
    "POI:",
    poiPath
  );
}


/*
 * 다른 파일에서 실제 POI를 사용할 수 있도록
 * 지역명 → 전체 POI + 카테고리명까지 완성해서 반환
 */
async function loadAreaPois(areaName) {
  const areaCode =
    await findAreaCode(areaName);

  const result =
    await getPois(areaCode);

  const pois =
    result.items;

  /*
   * 카테고리 코드 중복 제거
   */
  const uniqueCats =
    getUniqueCatCombinations(pois);

  const uniqueLcls =
    getUniqueLclsCombinations(pois);


  /*
   * 기존 cat 이름 변환
   */
  const resolvedCats = [];

  for (const category of uniqueCats) {
    const resolved =
      await resolveCatCombination(
        category
      );

    resolvedCats.push(resolved);
  }


  /*
   * lcls 이름 변환
   */
  const resolvedLcls = [];

  for (const category of uniqueLcls) {
    const resolved =
      await resolveLclsCombination(
        category
      );

    resolvedLcls.push(resolved);
  }


  /*
   * 각 POI에 한글 카테고리명까지 붙임
   */
  const enrichedPois =
    enrichPois(
      pois,
      resolvedCats,
      resolvedLcls
    );

  return {
    areaCode,
    totalCount:
      result.totalCount,

    pois:
      enrichedPois,
  };
}


/*
 * node backend/poi.js 로 직접 실행했을 때만
 * 기존 분석용 main() 실행
 */
if (require.main === module) {
  main().catch((error) => {
    console.error("\n오류 발생:");
    console.error(error);
  });
}


/*
 * server.js에서 사용할 함수 export
 */
module.exports = {
  loadAreaPois,
};
