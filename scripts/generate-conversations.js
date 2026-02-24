const fs = require('fs');
const crypto = require('crypto');

const randomEl = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Data pools
const subjects = ["Frontend", "Backend", "DevOps", "Database", "Mobile", "Security"];

const topics = {
    Frontend: {
        techs: ["React", "Vue", "Next.js", "Svelte", "Angular", "Tailwind", "CSS"],
        questions: [
            "Làm sao để optimize performance cho {tech}?",
            "Nên quản lý state bằng thư viện nào trong {tech}?",
            "Tao đang gặp lỗi re-render liên tục ở {tech}.",
            "Có nên dùng TypeScript với {tech} không?",
            "Tao muốn setup CI/CD cho {tech}.",
            "Best practice folder structure cho project {tech} là gì?",
            "Handle routing trong {tech} sao cho mượt?",
            "Tao hay bị memory leak khi dùng {tech}, tìm cách debug sao?",
            "SSR (Server-Side Rendering) có quan trọng với {tech} không?",
            "Migrate từ phiên bản cũ của {tech} lên mới nhất thì cần chú ý gì?"
        ],
        answers: [
            "Dùng useMemo và useCallback để tránh re-render. Ngoài ra có thể code splitting bằng React.lazy.",
            "Zustand hoặc Redux Toolkit đều tốt, nhưng Zustand nhẹ hơn nhiều. Nếu dùng {tech} thì Zustand quá hợp lý.",
            "Tránh truyền callback function hoặc object trực tiếp vào dependency array của useEffect. Nên bọc bằng useCallback/useMemo.",
            "Rất nên dùng TypeScript để catch bug sớm và có autocompletion tốt hơn. Cứ mạnh dạn apply nhé.",
            "Có thể dùng GitHub Actions build và deploy thẳng lên Vercel or AWS S3. Workflow rất nhanh gọn.",
            "Nên chia theo feature-based. Ví dụ: src/features/auth, src/features/products. Thay vì gom hết type/component vào một cục.",
            "Với {tech}, hệ thống routing của nó đã ổn rồi, quan trọng là dùng lazy loading để load component khi thực sự vào trang.",
            "Thường do không cleanup window event listeners hoặc timeout trong useEffect. Inspect heap memory trong Chrome devtools nhé.",
            "Nếu cần SEO thì cực kỳ quan trọng, còn nếu build Dashboard nội bộ thì Client-side rendering là đủ.",
            "Nhớ đọc kỹ changelog. Thông thường {tech} sẽ có codemods hỗ trợ tự động convert code cũ lên mới để tiết kiệm công sức."
        ]
    },
    Backend: {
        techs: ["Node.js", "NestJS", "Go", "Python", "Java Spring", "Rust", "Express"],
        questions: [
            "Kiến trúc nào tốt cho dự án {tech} lớn?",
            "Xử lý concurrent requests trong {tech} thế nào?",
            "Tao thích dùng gRPC hơn REST cho {tech}, mày thấy sao?",
            "Làm sao bảo mật API trong {tech}?",
            "Log management thế nào là chuẩn?",
            "Microservices hay Monolith cho API viết bằng {tech}?",
            "Implement WebSockets trong {tech} có bị quá tải không?",
            "Phân quyền (RBAC/ABAC) nên làm ở mức middleware hay trong logic của {tech}?",
            "Làm sao tracking bottleneck nếu API {tech} chạy chậm?",
            "Tích hợp Stripe payment logic vào {tech} có lưu ý gì bảo mật?"
        ],
        answers: [
            "Nên áp dụng Clean Architecture hoặc Hexagonal Architecture. Phân tách rõ Domain, Use Cases và Interface Adapters.",
            "Tận dụng async/await và connection pooling. Nếu tải quá lớn thì dùng queue như RabbitMQ or BullMQ đệm trước.",
            "gRPC tuyệt vời cho microservices vì performance cao và strict typing với Protobuf. Nhưng debug frontend gọi trực tiếp sẽ khó hơn REST.",
            "Bắt buộc dùng rate limiting, JWT authentication, helmet headers và validate input bằng Zod hoặc Joi cẩn thận.",
            "Nên gom log về một chỗ bằng ELK stack (Elasticsearch, Logstash, Kibana) hoặc Grafana Loki. Format log chuẩn JSON thay vì text thường.",
            "Cứ bắt đầu bằng Modular Monolith đi. Khi nào {tech} team phình to thì mới nên tách microservices.",
            "Tùy vào implementation. Nếu broadcast lượng lớn thì hãy tích hợp Redis adapter để scale nhiều instance {tech} cùng lúc.",
            "Nên check phân quyền ở tận tầng controller hoặc service auth guard để đảm bảo không bị lọt. Có thể dùng Casbin.",
            "Dùng APM như Datadog hoặc Sentry Performance, nó sẽ vẽ flame graph cho biết SQL hay function nào đang nghẽn cổ chai.",
            "Bắt buộc dùng Stripe Webhooks để xác nhận đơn. Luôn verify stripe signature header trước khi xử lý, đừng bao giờ tin vào payload client gửi."
        ]
    },
    DevOps: {
        techs: ["Docker", "Kubernetes", "AWS", "Terraform", "GitHub Actions", "GitLab CI"],
        questions: [
            "Làm sao tối ưu image size cho {tech}?",
            "Deploy {tech} lên cluster thì cần chú ý gì?",
            "Tao đang setup pipeline auto deploy bằng {tech}.",
            "Có nên dùng self-hosted runner cho {tech} không?",
            "Config auto-scaling thế nào cho hợp lý?",
            "Làm sao test hạ tầng IaC (Infrastructure as Code) trong {tech}?",
            "Xử lý secret keys / môi trường trong {tech} ra sao?",
            "Mày hay dùng Blue-Green hay Canary deployment với {tech}?",
            "Backup database bằng pipeline {tech} tự động được không?",
            "Giải pháp monitor traffic network trong {tech}?"
        ],
        answers: [
            "Dùng multi-stage build và chọn base image là alpine. Tránh copy những file không cần thiết qua .dockerignore.",
            "Cần setup resource requests và limits chuẩn. Dùng helm chart để quản lý config cho dễ maintain.",
            "Nhớ cache dependencies để giảm thời gian build. Dùng pipeline secrets ẩn API keys an toàn.",
            "Self-hosted tiết kiệm chi phí nếu build quá nhiều tác vụ nặng, nhưng mày phải tự lo OS security và upgrade maintenance.",
            "Dùng HPA (Horizontal Pod Autoscaler) dựa trên CPU utilization (vd >70%) hoặc dựa vào metrics của Prometheus.",
            "Có thể dùng Terratest (nếu viết bằng Go) để viết unit test cho các module infrastructure trước khi apply vào AWS.",
            "Tuyệt đối không hardcode. Nên dùng HashiCorp Vault hoặc AWS Secrets Manager để tự động inject vào runtime.",
            "Canary thì an toàn hơn, mình redirect 5-10% traffic vô phiên bản mới để test bug. Nếu ổn thì tăng dần lên 100%.",
            "Được, cronjob chạy daily backup → gzip → đẩy thẳng lên AWS S3 và rớt log về Slack. Nhưng nhớ test kịch bản restore nhé.",
            "Service Mesh như Istio hoặc Linkerd sinh ra để giải quyết vụ đó, nó cho mày full trace network, zero-trust security luôn."
        ]
    },
    Database: {
        techs: ["PostgreSQL", "MongoDB", "Redis", "MySQL", "Cassandra", "Elasticsearch"],
        questions: [
            "Làm sao để query table hàng chục triệu dòng trong {tech} nhanh hơn?",
            "Setup replication cho {tech} thế nào cho chuẩn?",
            "Tao bị deadlock khi transaction trong {tech}, fix sao?",
            "Có nên dùng ORM với {tech} không hay viết raw query?",
            "Migration scheme database thì tool nào OK?",
            "Trường hợp nào nên đánh index text search full-text trong {tech}?",
            "Cách xử lý data migration 10 triệu bản ghi không downtimes ngắt quãng?",
            "Nếu {tech} đang đầy disk thì auto clean sao?",
            "Kết hợp {tech} với công cụ message broker nào hợp lý khi design streaming?",
            "Bản chất ACID trong {tech} hoạt động thế nào giữa các connection đồng thời?"
        ],
        answers: [
            "Tạo composite index đúng thứ tự cột where, dùng EXPLAIN ANALYZE để check. Nếu vẫn chậm thì bắt buộc tính partitioning the range date.",
            "Setup 1 Master (Write/Read) và multiple Replicas (Read-only). Cổng ứng dụng có thể dùng PgBouncer để quản lý connection pooling.",
            "Hãy review lại thiết kế thứ tự thiết lập lock update locks liên tục. Luôn giữ cùng thứ tự truy cập resource ở mọi transaction.",
            "Dùng Prisma hoặc Sequelize để thao tác nhanh CRUD. Nhưng báo cáo phức tạp với groupby, window function thì nên viết SQL thô sẽ kiểm soát tốt hơn.",
            "Prisma migrate hoặc Flyway (java). Tôn chỉ: code migrate luôn đi kèm rollback script, test rollback kỹ ở staging.",
            "Chỉ khi cần tìm kiếm fuzzy, LIKE '%...%' thì mới cần text index. Tuy nhiên nếu dữ liệu quá to, chuyển hẳn sang Elasticsearch hoặc Algolia.",
            "Dùng kĩ thuật Chunking: update 1000 records mỗi batch nền (background worker) thay vì lock một cục 10 triệu. Đếm tiến độ qua Redis.",
            "Thiết lập retention policy, auto drop partition của các tháng > 6 tháng. Đồng thời cài alert disk > 85% bắn cảnh báo PagerDuty.",
            "Rất hay kẹp cung với Kafka dùng mô hình Change Data Capture (CDC - vd Debezium). Ứng dụng khác chỉ việc nghe thông báo từ Kafka.",
            "Mỗi DBMS có cơ chế Isolation Level khác nhau (như Read Committed). Hiểu đơn giản là các connection che chắn lẫn nhau đến khi commit thành công."
        ]
    },
    Mobile: {
        techs: ["React Native", "Flutter", "Swift", "Kotlin", "Expo"],
        questions: [
            "Màn hình list bị giật lag trong {tech}, tối ưu sao cho mượt 60fps?",
            "Làm deep linking click từ email mở app trực tiếp trong {tech}?",
            "Lưu trữ offline data bằng gì trong {tech} khi thiết bị mất kết nối?",
            "Tao định update app hot-fix đẩy thẳng xuống máy ng dùng không qua Store (OTA)?",
            "Setup push notifications cho {tech} có cần config native sâu không?",
            "Vấn đề state management trên {tech} lúc background app bị hụt dữ liệu.",
            "Layout responsive giữa iPhone màn bé và iPad ngang trong {tech}?",
            "Xin vài tricks về Memory management khi app load nhiều ảnh lớn.",
            "Đưa app written in {tech} lên Apple App Store hay bị reject lõng chõng lỗi nào?",
            "Xử lý In-app Purchase (IAP) với {tech} sao cho bảo mật không bị cheat?"
        ],
        answers: [
            "Với danh sách cực dài, dùng cơ chế virtualized list (như FlatList/RecyclerView). Tuyệt đối bọc memo và xẻ nhỏ các thẻ component con.",
            "Cần map URL scheme của app sâu trong file AndroidManifest.xml và Info.plist iOS, sau đó lắng nghe URL qua event listener.",
            "Phổ biến thì dùng SQLite, Realm hoặc WatermelonDB. Mấy cái đó serialize dữ liệu nhanh và memory footprint nhẹ cho máy yếu.",
            "Có thể dùng Microsoft CodePush (đủ tốt) hoặc EAS Update. Nó download JS bundle ngầm đè lên, ng dùng restart app là nhận code mới.",
            "Gần như chắc chắn. Dùng Firebase (FCM) là chuẩn bài nhất, nhưng cài certificate của Apple Developer P8 hơi loằng ngoằng. Đọc kĩ doc.",
            "App bị OS thu hồi resource khi ném chạy nền quá lâu là chuyện thường. Nhớ phải sync state với local storage và restore lại lúc resume.",
            "Dùng Flexbox linh hoạt hoặc MediaQueries check độ phân giải DeviceWidth. Với Tablet nhiều lúc phải vẽ hẳn UX 2 cột side-by-side.",
            "Đừng tự dùng Image mặc định. Trong RN dùng FastImage, nó cache native Glide trên Android và SDWebImage trên iOS. Phải resize ảnh từ server.",
            "Lỗi to nhất: Xin quyền Privacy (Camera/Location/Tracking) mà không giải thích rõ tại sao. Kế đến là app đơ lúc init không load nổi data.",
            "Đừng bao giờ xử lý logic tính phí phía Client. Client gọi mua -> Apple trả Receipt -> Ném Receipt lên server Node.js của mày -> Server call Apple server verify."
        ]
    },
    Security: {
        techs: ["JWT", "OAuth2", "CORS", "HTTPS", "Cryptography"],
        questions: [
            "Cách xịn nhất để trữ token JWT trên browser là gì?",
            "Review hộ tao logic: access token hết hạn dùng refresh token xin mới tự động.",
            "Fix lỗi {tech} khi tích hợp third-party payment form?",
            "Tao có nên tự viết hàm SHA256 mã hoá mật khẩu user?",
            "User báo token bị đánh cắp thì thu hồi kiểu gì nếu JWT là stateless?",
            "CSRF vs XSS bảo vệ app thế nào khỏi 2 thứ đó?",
            "API bị dội bom request (DDoS / Brute Force) từ cùng IP chặn thế nào?",
            "Cách config {tech} để các domain nội bộ chia sẻ API trơn tru?",
            "Mô hình SSO (Single Sign-On) qua {tech} làm từ zero mất tuần không?",
            "Có tool tự dộng scan source code báo lỗi bảo mật không?"
        ],
        answers: [
            "Tuyệt đối không để vô localStorage vì ăn XSS. Giấu dưới Cookie kèm cờ HttpOnly, Secure, SameSite=Strict là chuẩn nhất.",
            "Pattern đúng là: client catch HTTP 401 chặn các async fetch lại, móc refresh token gửi /refresh lấy access mới, rồi loop replay lại mớ request bị nhai.",
            "Lỗi liên quan Same-Origin Policy. Phải config kĩ Header cho phép Cross-Origin (Access-Control-Allow-Origin). Nếu quá chặt Payment Gateway sẽ fail.",
            "Không bao giờ. Hash tay gặp vụ 'rainbow table' dễ vỡ. Phải xài bcrypt, Argon2 hoặc scrypt vì bọn này cố tình tính chậm (CPU heavy) + cấp muối (Salt) tự động.",
            "Tạo Blacklist Token trên Redis cho Logout/Revoke. Middleware auth sẽ check Redis trước khi thả qua. Giảm hạn access token xuống 15p thì dù có mất 15p là vô dụng.",
            "Nôm na XSS trị bằng việc sanitize mọi nội dung nhập vào, encode output, gán HTTPOnly. CSRF trị gằng gắn Cross-site token vô header theo từng phiên cookie.",
            "Lớp ngoài chặn bằng Cloudflare/AWS WAF. Lớp trong tự cài Middleware Rate-limiter (vd giới hạn 100 requests/IP/5 phút). Vượt ngưỡng quăng mã 429 Too Many Requests.",
            "Khai báo thẳng các IP/Origin tin tưởng trong biến môi trường server (Whitelist). Đừng bao giờ quăng sao (Wildcard `*`) vào Header Allow.",
            "Làm tay đau đầu lắm (OAuth flows phức tạp). Khuyên cắm mẹ Auth0 hoặc AWS Cognito, Keycloak cho lẹ, có OIDC sẵn.",
            "Rất nhiều. Github có Dependabot soi library thủng. Code thì xài Sonarqube hoặc Snyk. Setup quăng vô Node CI chặn auto đẩy Git."
        ]
    }
};

const greetings = [
    "Chào mày, nay tao bắt đầu project mới đây.",
    "Hello, giúp tao setup con app này phát.",
    "Ê mày, rảnh không tao hỏi tý về tech stack.",
    "Chào! Tư vấn tao đoạn system design này lẹ.",
    "Hi, tao có mấy cái bug khoai phết cần mày xem.",
    "Hello agent, tóm tắt hộ kiến thức chỗ này."
];

const smalltalk_qs = [
    "Dạo này AI như mày thông minh lên phết ha.",
    "Cuối tuần này chắc tao vẫn code cày deadline.",
    "Tao mới đọc bài viết về DeepSeek, giá token rẻ bèo.",
    "Mắt nhòe code mệt mỏi quá, có idea gì xả stress không?",
    "Thị trường IT năm nay có vẻ ấm lại rồi đúng không mày?",
    "Nếu tao làm dev lâu có nên nhảy qua làm PM / QA không?"
];

const smalltalk_as = [
    "Bọn tao được huấn luyện liên tục nên bớt ngáo sảng đi nhiều. Quan trọng mày prompt thế nào.",
    "Cố lên ông, chốt xong KPI rồi đi nhậu 1 chầu xả láng. Tao support hết mình.",
    "Đúng vậy, bọn model Tàu giờ scale khủng, API rẻ mà cũng khá chất lượng xài ok la.",
    "Tắt màn hình đi bộ tầm 15p, uống nước chè xanh rồi hẵng lùa bug, tao hứa không lười đâu.",
    "Trễ rồi nhưng có vẻ nhiều cty rục rịch hốt dev AI. Trang bị kĩ năng kĩ sư hệ thống đắt giá lắm.",
    "Làm Tech Lead luôn cho gấu. Chuyển hướng có vẻ sẽ đổi mindset nhưng cứ build đam mê là tới."
];

const closures = [
    "OK hiểu rồi, tao đi commit code tiếp đây.",
    "Thanks mày, giải thích siêu dễ hiểu ảo thật.",
    "Tuyệt vời, clear luôn. Hẹn mai bàn tiếp nhé.",
    "Cảm ơn mày đã support vất vả, bye bye!",
    "Đỉnh cao! Xong việc rồi tao đi ngủ đây, cạn kiệt HP.",
    "Xong task tao rồi, đóng ticket đi uống bia thôi."
];

const agents = ['backend-copilot', 'frontend-expert', 'devops-guru', 'data-scientist', 'mobile-dev', 'system-architect'];

function generateConversation(id) {
    const numExchanges = randomInt(10, 50);
    const numTopics = randomInt(1, 4); // 1-4 topics per conversation

    // Pick topics
    const selectedTopics = [];
    while (selectedTopics.length < Math.min(numTopics, subjects.length)) {
        const t = randomEl(subjects);
        if (!selectedTopics.includes(t)) selectedTopics.push(t);
    }

    const exchanges = [];

    // Greeting
    exchanges.push({
        userMessage: randomEl(greetings),
        agentResponse: "Chào bạn thân! Mình sẵn sàng đây. Xoay quanh vụ " + selectedTopics.join(' hay ') + " hay chủ đề gì nay nhỉ?"
    });

    let currentExchange = 1;

    // We want the total Q&A across topics to meet numExchanges (minus start/end)
    const targetMiddleExchanges = numExchanges - 2;

    // Generate questions/answers iteratively
    for (let i = 0; i < targetMiddleExchanges; i++) {
        // Randomly insert smalltalk 10% of the time
        if (Math.random() < 0.1) {
            const sIdx = randomInt(0, smalltalk_qs.length - 1);
            exchanges.push({
                userMessage: smalltalk_qs[sIdx],
                agentResponse: smalltalk_as[sIdx]
            });
            currentExchange++;
            continue;
        }

        // Otherwise pick a topic and a tech
        const subject = randomEl(selectedTopics);
        const tp = topics[subject];
        const tech = randomEl(tp.techs);

        // Pick a Q/A pair based on topic length
        const qaIndex = randomInt(0, tp.questions.length - 1);

        const qTemplate = tp.questions[qaIndex];
        const aTemplate = tp.answers[qaIndex];

        exchanges.push({
            userMessage: qTemplate.replace(/{tech}/g, tech),
            agentResponse: aTemplate.replace(/{tech}/g, tech)
        });
        currentExchange++;
    }

    // Closure
    exchanges.push({
        userMessage: randomEl(closures),
        agentResponse: "Không có gì! Nhớ nhắn tao nếu cần gánh rank hay debug hỗ trợ thêm nhé. Đi quẩy đi!"
    });

    return {
        conversationId: crypto.randomUUID(),
        agentId: randomEl(agents),
        topics: selectedTopics,
        exchangeCount: exchanges.length,
        exchanges: exchanges
    };
}

const conversations = [];
// Mức 100 conversation theo yêu cầu
for (let i = 1; i <= 100; i++) {
    conversations.push(generateConversation(i));
}

const outputFile = 'dataset-100-conversations.json';
fs.writeFileSync(outputFile, JSON.stringify(conversations, null, 2));

console.log('✅ Dataset generation complete:');
console.log(`📝 Generated ${conversations.length} conversations.`);
console.log(`📦 Saved to ${outputFile}`);
