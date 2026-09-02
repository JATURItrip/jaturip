const express =
  require("express");

const fs =
  require("fs");

const path =
  require("path");

const {
  loadAreaPois,
} =
  require("./poi");

const {
  getSwipeCards,
  derivePreferences,
} =
  require("./filter");

const {
  loadStayTimeMap,
} =
  require("./staytime");

const {
  recommendCourse,
  recommendCourseWithRouting,
} =
  require("./course");

const {
  isRoutingEnabled,
} =
  require("./routing");


const app =
  express();

/*
 * 포트가 이미 쓰이고 있으면
 * PORT=3100 node backend/server.js 처럼 바꿔 실행한다.
 */
const PORT =
  Number(process.env.PORT) ||
  3000;


/*
 * JSON 요청 받기
 */
app.use(
  express.json()
);


/*
 * 화면 제공
 *
 * index.html은 저장소 루트에 있고
 * 바깥 파일을 하나도 참조하지 않는다.
 *
 * express.static으로 루트를 통째로 열면
 * package.json이나 backend 소스,
 * 수집해 둔 데이터 파일까지 그대로 받아갈 수 있으므로
 * 이 파일 하나만 내보낸다.
 */
const INDEX_PATH =
  path.join(
    __dirname,
    "..",
    "index.html"
  );


app.get(
  ["/", "/index.html"],
  (req, res) => {
    res.sendFile(INDEX_PATH);
  }
);


/*
 * 서버 실행 중 사용할 POI 캐시
 *
 * TourAPI를 요청할 때마다
 * 2130개를 다시 가져오지 않기 위함
 */
let poiCache = null;


/*
 * 체류시간 레코드 캐시
 *
 * staytime.js가 만들어 둔 파일을 읽는다.
 */
let stayTimeCache = null;


/*
 * 현재 사용자에게 보여준
 * 스와이프 카드 6장
 *
 * 데모이므로 서버 메모리에 저장
 */
let currentSwipeCards = [];


/*
 * 가장 최근 취향 분석 결과
 *
 * 프론트가 취향을 다시 보내지 않아도
 * 코스를 만들 수 있게 해 둔다.
 */
let lastPreferences = null;


const ENRICHED_POI_PATH =
  path.join(
    __dirname,
    "seoul-poi-enriched.json"
  );


/*
 * 서울 POI 로드
 *
 * 이미 수집해 둔 파일이 있으면 그걸 쓴다.
 * TourAPI 전체 수집은 20페이지가 넘어서
 * 데모 중에 실행하기에는 너무 느리다.
 */
async function getPois() {
  if (poiCache) {
    return poiCache;
  }


  if (
    fs.existsSync(ENRICHED_POI_PATH)
  ) {
    poiCache =
      JSON.parse(
        fs.readFileSync(
          ENRICHED_POI_PATH,
          "utf-8"
        )
      );

    console.log(
      `저장된 서울 POI ${poiCache.length}개 로드 완료`
    );

    return poiCache;
  }


  console.log(
    "TourAPI에서 서울 POI 로딩 중..."
  );

  const result =
    await loadAreaPois(
      "서울"
    );

  poiCache =
    result.pois;

  console.log(
    `서울 POI ${poiCache.length}개 로드 완료`
  );

  return poiCache;
}


function getStayTimeMap() {
  if (stayTimeCache) {
    return stayTimeCache;
  }

  stayTimeCache =
    loadStayTimeMap();

  console.log(
    `체류시간 레코드 ${stayTimeCache.size}개 로드 완료`
  );

  return stayTimeCache;
}


/*
 * 서버 상태 확인용
 */
app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status: "ok",
    });
  }
);


/*
 * =====================================================
 * GET /api/swipe-cards
 *
 * 실제 TourAPI POI
 * → filter.js
 * → 스와이프 카드 6장
 * =====================================================
 */
app.get(
  "/api/swipe-cards",
  async (req, res) => {
    try {
      const pois =
        await getPois();

      const cards =
        getSwipeCards(
          pois,
          6
        );

      /*
       * 사용자가 실제로 본 카드 기억
       */
      currentSwipeCards =
        cards;

      /*
       * 프론트에는 필요한 정보만 전달
       *
       * combination은 내부 판단용이라
       * 굳이 사용자에게 보낼 필요 없음
       */
      const responseCards =
        cards.map(
          (card) => ({
            id:
              card.id,

            title:
              card.title,

            category:
              card.category,

            sceneText:
              card.sceneText,

            image:
              card.image,
          })
        );

      res.json({
        count:
          responseCards.length,

        cards:
          responseCards,
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "스와이프 카드를 생성하지 못했습니다.",
      });
    }
  }
);


/*
 * =====================================================
 * POST /api/preferences
 *
 * 프론트에서:
 *
 * {
 *   swipes: [
 *      { sceneId: "123", liked: true },
 *      { sceneId: "456", liked: false }
 *   ]
 * }
 *
 * 형태로 전달
 * =====================================================
 */
app.post(
  "/api/preferences",
  (req, res) => {
    try {
      const {
        swipes,
      } = req.body;


      if (
        !Array.isArray(swipes)
      ) {
        return res
          .status(400)
          .json({
            error:
              "swipes 배열이 필요합니다.",
          });
      }


      if (
        currentSwipeCards.length === 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "먼저 스와이프 카드를 조회해야 합니다.",
          });
      }


      /*
       * 프론트가 combination 값을
       * 직접 보내도록 하지 않는다.
       *
       * sceneId를 가지고 서버가
       * 원래 카드의 태그를 다시 찾는다.
       */
      const normalizedSwipes = [];


      for (const swipe of swipes) {

        const card =
          currentSwipeCards.find(
            (item) =>
              String(item.id) ===
              String(swipe.sceneId)
          );


        if (!card) {
          continue;
        }


        normalizedSwipes.push({
          sceneId:
            card.id,

          liked:
            Boolean(
              swipe.liked
            ),

          combination:
            card.combination,
        });
      }


      /*
       * O / X 결과
       * → 4개 조합 선호 해석
       */
      const preferences =
        derivePreferences(
          normalizedSwipes
        );


      lastPreferences =
        preferences;


      res.json({
        preferences,
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "취향 결과를 처리하지 못했습니다.",
      });
    }
  }
);


/*
 * =====================================================
 * POST /api/course
 *
 * 프론트에서:
 *
 * {
 *   availableMinutes: 120,
 *   start: { lat: 37.5665, lng: 126.9780 },
 *   end:   { lat: 37.4979, lng: 127.0276 },   // 없으면 출발지로 복귀
 *   departAt: "14:00",                         // 없으면 현재 시각
 *   preferences: { preferred: [...], ... },   // 없으면 마지막 결과 사용
 *   useRouting: true                           // 기본값 true
 * }
 *
 * useRouting이 true이고 KAKAO_REST_KEY가 있으면
 * 최종 코스의 이동시간을 카카오모빌리티 길찾기로
 * 다시 계산한다.
 *
 * 응답의 travelBasis가 "routed"면 보정된 값이고
 * "estimate"면 직선거리 추정값이다.
 * =====================================================
 */
app.post(
  "/api/course",
  async (req, res) => {
    try {
      const {
        availableMinutes,
        start,
        end,
        departAt,
        preferences,
        useRouting,
      } = req.body ?? {};


      const minutes =
        Number(availableMinutes);


      if (
        !Number.isFinite(minutes) ||
        minutes <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "availableMinutes(자투리 시간, 분)가 필요합니다.",
          });
      }


      if (
        !start ||
        !Number.isFinite(Number(start.lat)) ||
        !Number.isFinite(Number(start.lng))
      ) {
        return res
          .status(400)
          .json({
            error:
              "start.lat / start.lng 좌표가 필요합니다.",
          });
      }


      const pois =
        await getPois();

      const stayTimeMap =
        getStayTimeMap();


      /*
       * 키가 없으면 길찾기를 부를 수 없으므로
       * 추정값 그대로 간다.
       */
      const withRouting =
        (useRouting ?? true) &&
        isRoutingEnabled();


      const recommend =
        withRouting
          ? recommendCourseWithRouting
          : recommendCourse;


      const result =
        await recommend({
          pois,
          stayTimeMap,

          preferences:
            preferences ??
            lastPreferences,

          availableMinutes:
            minutes,

          start: {
            lat: Number(start.lat),
            lng: Number(start.lng),
          },

          end:
            end
              ? {
                  lat: Number(end.lat),
                  lng: Number(end.lng),
                }
              : null,

          departAt:
            departAt ?? null,
        });


      res.json(result);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "코스를 생성하지 못했습니다.",
      });
    }
  }
);


/*
 * 서버 실행
 */
app.listen(
  PORT,
  () => {
    console.log(
      `자투립 서버 실행: http://localhost:${PORT}`
    );
  }
);
