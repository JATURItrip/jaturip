const fs = require("fs");
const path = require("path");

const {
  CATEGORY_TAGS,
} = require("./filter");


const poiPath = path.join(
  __dirname,
  "seoul-poi-enriched.json"
);

const pois = JSON.parse(
  fs.readFileSync(
    poiPath,
    "utf-8"
  )
);


/* ========================================
   허용된 태그
======================================== */

const VALID_ENVIRONMENT = [
  "indoor",
  "outdoor",
];

const VALID_ACTIVITY_STYLE = [
  "moving",
  "staying",
];


/* ========================================
   1. CATEGORY_TAGS 자체 검사
======================================== */

function validateCategoryRules() {
  const errors = [];

  for (
    const [code, tags]
    of Object.entries(CATEGORY_TAGS)
  ) {

    if (
      !Array.isArray(tags.environment) ||
      tags.environment.length === 0
    ) {
      errors.push(
        `${code}: environment가 비어 있음`
      );
    }

    if (
      !Array.isArray(tags.activityStyle) ||
      tags.activityStyle.length === 0
    ) {
      errors.push(
        `${code}: activityStyle이 비어 있음`
      );
    }


    for (
      const value
      of tags.environment ?? []
    ) {
      if (
        !VALID_ENVIRONMENT.includes(value)
      ) {
        errors.push(
          `${code}: 잘못된 environment → ${value}`
        );
      }
    }


    for (
      const value
      of tags.activityStyle ?? []
    ) {
      if (
        !VALID_ACTIVITY_STYLE.includes(value)
      ) {
        errors.push(
          `${code}: 잘못된 activityStyle → ${value}`
        );
      }
    }
  }

  return errors;
}


/* ========================================
   2. POI에 태그 적용
======================================== */

function applyTags(poi) {
  const code =
    poi.lclsSystm3;

  const tags =
    CATEGORY_TAGS[code];

  return {
    ...poi,

    jaturipTags:
      tags ?? null,
  };
}


const taggedPois =
  pois.map(applyTags);


/* ========================================
   3. 태그 없는 POI 검사
======================================== */

const missingPois =
  taggedPois.filter(
    (poi) =>
      !poi.jaturipTags
  );


/* ========================================
   4. 태그 없는 카테고리 코드 집계
======================================== */

const missingCategoryMap =
  new Map();

for (const poi of missingPois) {
  const code =
    poi.lclsSystm3 || "NO_CODE";

  if (
    !missingCategoryMap.has(code)
  ) {
    missingCategoryMap.set(
      code,
      {
        code,
        name:
          poi.lclsName?.level3 ??
          null,

        count: 0,

        examples: [],
      }
    );
  }

  const item =
    missingCategoryMap.get(code);

  item.count++;

  if (
    item.examples.length < 3
  ) {
    item.examples.push(
      poi.title
    );
  }
}


/* ========================================
   5. 실제 태그 분포
======================================== */

const tagDistribution = {
  indoor: 0,
  outdoor: 0,
  moving: 0,
  staying: 0,
};

for (const poi of taggedPois) {
  const tags =
    poi.jaturipTags;

  if (!tags) {
    continue;
  }

  for (
    const environment
    of tags.environment
  ) {
    tagDistribution[
      environment
    ]++;
  }

  for (
    const activity
    of tags.activityStyle
  ) {
    tagDistribution[
      activity
    ]++;
  }
}


/* ========================================
   6. 카테고리별 실제 장소 샘플
======================================== */

const samples =
  new Map();

for (const poi of taggedPois) {
  if (!poi.jaturipTags) {
    continue;
  }

  const code =
    poi.lclsSystm3;

  if (!samples.has(code)) {
    samples.set(
      code,
      {
        category:
          poi.lclsName?.level3 ??
          code,

        tags:
          poi.jaturipTags,

        examples: [],
      }
    );
  }

  const item =
    samples.get(code);

  if (
    item.examples.length < 3
  ) {
    item.examples.push(
      poi.title
    );
  }
}


/* ========================================
   결과 출력
======================================== */

console.log(
  "\n===================================="
);

console.log(
  "CATEGORY_TAGS 규칙 검사"
);

console.log(
  "===================================="
);

const ruleErrors =
  validateCategoryRules();

if (
  ruleErrors.length === 0
) {
  console.log(
    "✅ 규칙 오류 없음"
  );
} else {
  console.log(
    `❌ 규칙 오류 ${ruleErrors.length}개`
  );

  console.log(
    ruleErrors
  );
}


console.log(
  "\n===================================="
);

console.log(
  "POI 태깅 결과"
);

console.log(
  "===================================="
);

console.log(
  "전체 POI:",
  taggedPois.length
);

console.log(
  "태깅 성공:",
  taggedPois.length -
    missingPois.length
);

console.log(
  "태깅 실패:",
  missingPois.length
);


console.log(
  "\n===================================="
);

console.log(
  "누락된 카테고리"
);

console.log(
  "===================================="
);

if (
  missingCategoryMap.size === 0
) {
  console.log(
    "✅ 누락 카테고리 없음"
  );
} else {
  console.log(
    [
      ...missingCategoryMap.values(),
    ]
  );
}


console.log(
  "\n===================================="
);

console.log(
  "태그 분포"
);

console.log(
  "===================================="
);

console.log(
  tagDistribution
);


console.log(
  "\n===================================="
);

console.log(
  "카테고리별 장소 샘플"
);

console.log(
  "===================================="
);

for (
  const [code, data]
  of samples
) {
  console.log(
    `\n${code} / ${data.category}`
  );

  console.log(
    "태그:",
    data.tags
  );

  console.log(
    "장소:",
    data.examples.join(", ")
  );
}


/* ========================================
   태깅된 POI 파일도 저장
======================================== */

const outputPath =
  path.join(
    __dirname,
    "seoul-poi-tagged.json"
  );

fs.writeFileSync(
  outputPath,
  JSON.stringify(
    taggedPois,
    null,
    2
  ),
  "utf-8"
);

console.log(
  "\n태깅 결과 저장:",
  outputPath
);