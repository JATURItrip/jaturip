const fs =
  require("fs");

const path =
  require("path");

const {
  parseStayTime,
  parsePlayTime,
  DEFAULT_STAY_MINUTES,
} =
  require("./staytime");


let passed = 0;
let failed = 0;


function check(label, actual, expected) {
  const actualText =
    JSON.stringify(actual);

  const expectedText =
    JSON.stringify(expected);


  if (actualText === expectedText) {
    passed++;
    return;
  }

  failed++;

  console.log(
    `\n실패: ${label}`
  );

  console.log(
    "  기대:",
    expectedText
  );

  console.log(
    "  실제:",
    actualText
  );
}


function stay(raw) {
  const result =
    parseStayTime(raw);

  if (result.rejected) {
    return result.rejected;
  }

  return [
    result.minMinutes,
    result.recommendedMinutes,
    result.maxMinutes,
  ];
}


/* =========================================================
   1. 소요시간 파싱

   TourAPI 서울 문화시설 213건에서
   spendtime이 채워진 15건 전부 + 엣지 케이스
========================================================= */

console.log(
  "\n======================================"
);

console.log(
  "1. 소요시간 파싱"
);

console.log(
  "======================================"
);


/* 실제 데이터 15건 */

check(
  "경기여고 경운박물관",
  stay("약 30분"),
  [30, 30, 30]
);

check(
  "공평도시유적전시관",
  stay("약 1시간"),
  [60, 60, 60]
);

check(
  "국립현대미술관 서울",
  stay("2시간"),
  [120, 120, 120]
);

check(
  "김대중도서관",
  stay("약 1시간 30분"),
  [90, 90, 90]
);

check(
  "박여숙화랑",
  stay("약 1시간"),
  [60, 60, 60]
);

check(
  "배봉산숲속도서관 (운영시간 오염)",
  stay("월~금 09:00 ~ 22:00 / 토~일 09:00 ~ 18:00"),
  "operating-hours"
);

check(
  "서울대학교 박물관 (U+223C 물결표)",
  stay("1∼2시간 정도"),
  [60, 90, 120]
);

check(
  "스위트파크 롯데 어린이 식품체험관",
  stay("1시간"),
  [60, 60, 60]
);

check(
  "역삼도서관 (운영시간 오염)",
  stay("자료실 : 평일 09:00 - 22:00 / 주말 09:00 -17:00  /  열람실: 평일,주말 07:00 - 22:00"),
  "operating-hours"
);

check(
  "유금와당박물관",
  stay("약 1시간"),
  [60, 60, 60]
);

check(
  "전쟁기념관",
  stay("약 2시간"),
  [120, 120, 120]
);

check(
  "포스코미술관 (범위)",
  stay("약 30분~1시간"),
  [30, 45, 60]
);

check(
  "한생연 휴먼탐구과학관",
  stay("60분 내외"),
  [60, 60, 60]
);

check(
  "한전아트센터 공연장 (파싱 불가)",
  stay("공연 별로 상이함"),
  "unparseable"
);

check(
  "KBS온",
  stay("1시간"),
  [60, 60, 60]
);


/* 엣지 케이스 */

check(
  "빈 문자열",
  stay(""),
  "empty"
);

check(
  "null",
  stay(null),
  "empty"
);

check(
  "시간 반",
  stay("1시간 반"),
  [90, 90, 90]
);

check(
  "하이픈 범위",
  stay("30분-1시간"),
  [30, 45, 60]
);

check(
  "단위 없는 왼쪽 (분)",
  stay("30~40분"),
  [30, 35, 40]
);

check(
  "HTML 줄바꿈 포함",
  stay("약 1시간<br>30분"),
  [90, 90, 90]
);

check(
  "너무 짧음",
  stay("3분"),
  "out-of-range"
);

check(
  "너무 김",
  stay("20시간"),
  "out-of-range"
);

check(
  "역전된 범위",
  stay("2시간~30분"),
  "out-of-range"
);

check(
  "숫자 없음",
  stay("프로그램 별 상이"),
  "unparseable"
);

check(
  "권장값 5분 반올림",
  stay("40분~1시간"),
  [40, 50, 60]
);


/* =========================================================
   2. 운영 시간대 파싱

   서울 축제 71건의 playtime에서 나온 실제 형태
========================================================= */

console.log(
  "\n======================================"
);

console.log(
  "2. 운영 시간대 파싱"
);

console.log(
  "======================================"
);


check(
  "기본 구간",
  parsePlayTime("16:00~22:00"),
  [{ start: "16:00", end: "22:00" }]
);

check(
  "괄호 안 주말 시간",
  parsePlayTime("15:00~20:00(주말 12:00~20:00)"),
  [
    { start: "15:00", end: "20:00" },
    { start: "12:00", end: "20:00" },
  ]
);

check(
  "꼬리말 무시",
  parsePlayTime("10:00~20:00 (날짜별 상이)"),
  [{ start: "10:00", end: "20:00" }]
);

check(
  "요일 접두사 두 구간",
  parsePlayTime("일-목 17:30 ~ 21:30 , 금-토 17:30 ~ 22:00"),
  [
    { start: "17:30", end: "21:30" },
    { start: "17:30", end: "22:00" },
  ]
);

check(
  "날짜 접두사와 <br>",
  parsePlayTime("10.24~25(금,토) 12:00~20:00 <br>10.26(일) 12:00~18:00"),
  [
    { start: "12:00", end: "20:00" },
    { start: "12:00", end: "18:00" },
  ]
);

check(
  "시작 시각만",
  parsePlayTime("20:00"),
  [{ start: "20:00", end: null }]
);

check(
  "하이픈 구간",
  parsePlayTime("09:00 - 18:00"),
  [{ start: "09:00", end: "18:00" }]
);

check(
  "시각 없음",
  parsePlayTime("프로그램 별 상이"),
  []
);

check(
  "빈 값",
  parsePlayTime(""),
  []
);

check(
  "자정 넘김 표기",
  parsePlayTime("18:30~24:30"),
  [{ start: "18:30", end: "24:30" }]
);


/* =========================================================
   3. 고정값 테이블
========================================================= */

console.log(
  "\n======================================"
);

console.log(
  "3. 고정값 테이블"
);

console.log(
  "======================================"
);


const expectedKeys = [
  "indoor|staying",
  "indoor|moving",
  "indoor|mixed",
  "outdoor|staying",
  "outdoor|moving",
  "outdoor|mixed",
  "mixed|staying",
  "mixed|moving",
  "mixed|mixed",
];


check(
  "9개 버킷이 모두 있는가",
  Object.keys(DEFAULT_STAY_MINUTES).sort(),
  expectedKeys.slice().sort()
);


for (const key of expectedKeys) {
  const value =
    DEFAULT_STAY_MINUTES[key];

  check(
    `${key} 값이 min <= rec <= max 인가`,

    Boolean(
      value &&
      value.minMinutes <= value.recommendedMinutes &&
      value.recommendedMinutes <= value.maxMinutes
    ),

    true
  );
}


/* =========================================================
   4. 산출 파일 분포 (있을 때만)
========================================================= */

const outputPath =
  path.join(
    __dirname,
    "seoul-poi-staytime.json"
  );


if (fs.existsSync(outputPath)) {
  const records =
    JSON.parse(
      fs.readFileSync(
        outputPath,
        "utf-8"
      )
    );


  console.log(
    "\n======================================"
  );

  console.log(
    "4. 산출 파일 분포"
  );

  console.log(
    "======================================"
  );

  console.log(
    "총 레코드:",
    records.length
  );


  const ids =
    new Set(
      records.map(
        (record) => record.contentId
      )
    );

  check(
    "contentId 중복 없음",
    ids.size,
    records.length
  );


  const bySource = {};

  for (const record of records) {
    bySource[record.source] =
      (bySource[record.source] ?? 0) + 1;
  }

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


  const official =
    records.filter(
      (record) => record.isOfficial
    );

  console.log(
    "\n공식 소요시간",
    official.length,
    "건:"
  );

  official.forEach(
    (record) => {
      console.log(
        ` ${record.title}: ` +
        `${record.minMinutes}/${record.recommendedMinutes}/${record.maxMinutes}분 ` +
        `(${JSON.stringify(record.rawText)})`
      );
    }
  );


  const rejected =
    records.filter(
      (record) => record.rejectedReason
    );

  if (rejected.length > 0) {
    console.log(
      "\n파싱 실패",
      rejected.length,
      "건:"
    );

    rejected.forEach(
      (record) => {
        console.log(
          ` ${record.title}: ${record.rejectedReason}`
        );
      }
    );
  }


  const withWindows =
    records.filter(
      (record) =>
        record.operatingWindows.length > 0
    );

  console.log(
    "\n운영 시간대가 있는 레코드:",
    withWindows.length
  );


  const festivals =
    records.filter(
      (record) =>
        record.contentTypeId === "15"
    );

  if (festivals.length > 0) {
    /* 운영 시간대가 비었다면
       원본에 시각 표기가 아예 없었어야 한다.

       "프로그램 별 상이" 같은 값이 여기 해당한다. */
    const unexplained =
      festivals.filter(
        (record) =>
          record.operatingWindows.length === 0 &&
          /\d{1,2}\s*:\s*\d{2}/.test(
            record.rawPlayText ?? ""
          )
      );

    check(
      "운영 시간대가 빈 축제는 원본에도 시각이 없는가",
      unexplained.map((record) => record.title),
      []
    );


    console.log(
      "\n운영 시간대가 없는 축제:",

      festivals
        .filter(
          (record) =>
            record.operatingWindows.length === 0
        )
        .map(
          (record) =>
            `${record.title} (${JSON.stringify(record.rawPlayText)})`
        )
    );
  }


  check(
    "체류시간이 null인 건 숙박뿐인가",

    records
      .filter(
        (record) =>
          record.recommendedMinutes === null
      )
      .every(
        (record) =>
          record.contentTypeId === "32"
      ),

    true
  );

} else {
  console.log(
    "\n(seoul-poi-staytime.json이 아직 없어 분포 검사는 건너뜁니다)"
  );
}


/* =========================================================
   결과
========================================================= */

console.log(
  "\n======================================"
);

console.log(
  `통과 ${passed} / 실패 ${failed}`
);

console.log(
  "======================================"
);


if (failed > 0) {
  process.exit(1);
}
