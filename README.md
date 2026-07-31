# 고쟁이 수학 빠른 채점 및 웹 해설기

문항 번호를 입력하면 정답 이미지를 바로 표시하고, 필요할 때 해설 이미지를
열어 볼 수 있는 정적 웹 애플리케이션입니다.

## 웹앱 실행

`data.json`을 불러와야 하므로 HTML 파일을 직접 열지 말고 정적 웹 서버로
실행합니다.

```powershell
python -m http.server 8000
```

브라우저에서 <http://localhost:8000>으로 접속합니다.

## 이미지 추출

필요 패키지를 설치합니다.

```powershell
python -m pip install -r requirements.txt
```

프로젝트 루트에서 다음 명령을 실행합니다.

```powershell
python scripts/extract_answer_images.py
```

기본 입력 파일은 `answer_sheets/gojangee_gongsutwo.pdf`입니다. 다른 경로를
사용하려면 `--pdf` 옵션을 지정합니다.

```powershell
python scripts/extract_answer_images.py --pdf answer_sheets/다른답지.pdf
```

빠른 시험 추출은 문항 수를 제한할 수 있습니다.

```powershell
python scripts/extract_answer_images.py --max-problems 10
```

생성 결과:

```text
images/answers/ans_001.png
images/solutions/sol_001.png
data.json
output/pdf/extraction-report.json
```

스크립트는 현재 답지의 2단 편집을 따라 왼쪽 단, 오른쪽 단, 다음 페이지
순으로 문항 영역을 읽습니다. 해설이 다음 단이나 다음 페이지에 이어지면
여러 영역을 세로로 연결해 하나의 해설 이미지로 저장합니다.
