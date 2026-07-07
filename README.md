# 계좌진단서 — AI 포트폴리오 검진

보유종목 화면 캡처를 올리면 AI가 포트폴리오를 진단해주는 서비스.

## 구조

```
portfolio-service/
├── index.html        # 프론트엔드 (API 키 없음, /api/diagnose 호출)
├── api/
│   └── diagnose.js   # 서버리스 함수 (환경변수에서만 키를 읽음)
├── .env.example      # 환경변수 예시
└── package.json
```

## 배포 (Vercel, 5분)

1. Gemini API 키 발급: https://aistudio.google.com/apikey
2. 이 폴더를 GitHub에 올리기 (.env 파일은 절대 커밋 금지 — .gitignore에 이미 포함)
3. https://vercel.com 에서 New Project → 해당 저장소 import
4. Settings → Environment Variables 에 등록:
   - `GEMINI_API_KEY` = 발급받은 키
   - `GEMINI_MODEL` = gemini-2.0-flash (선택, 기본값 있음)
5. Deploy → 발급된 주소로 접속하면 끝

## 로컬에서 돌려보기

```bash
npm i -g vercel
cp .env.example .env.local   # 열어서 실제 키 입력
vercel dev                    # http://localhost:3000
```

`vercel dev`는 .env.local 을 자동으로 읽습니다.
정적 파일로 index.html만 열면 /api 가 없어서 진단이 안 되니, 반드시 vercel dev로 실행하세요.

## 주의사항

- API 키는 코드 어디에도 쓰지 않습니다. 환경변수에서만 읽습니다.
- 업로드된 이미지는 서버에 저장하지 않고 진단 후 즉시 폐기됩니다.
- 서비스 문구는 "진단/점검/정보 제공"을 유지하세요. 특정 종목 매수·매도 권유로
  넘어가면 투자자문업 규제 대상이 될 수 있습니다. 출시 전 법률 검토 권장.
