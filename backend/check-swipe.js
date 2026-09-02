const fs =
  require("fs");

const path =
  require("path");

const {
  getSwipeCards,
} =
  require("./filter");


const poiPath =
  path.join(
    __dirname,
    "seoul-poi-enriched.json"
  );


const pois =
  JSON.parse(
    fs.readFileSync(
      poiPath,
      "utf-8"
    )
  );


const cards =
  getSwipeCards(
    pois,
    6
  );


console.log(
  "\n=========================="
);

console.log(
  "생성된 스와이프 카드"
);

console.log(
  "=========================="
);


cards.forEach(
  (
    card,
    index
  ) => {

    console.log(
      `\n[${index + 1}]`
    );

    console.log(
      "장소:",
      card.title
    );

    console.log(
      "카테고리:",
      card.category
    );

    console.log(
      "장면:",
      card.sceneText
    );

    console.log(
      "조합:",
      card.combination
    );

   console.log(
      "이미지 URL:",
      card.image
    );
  }
);