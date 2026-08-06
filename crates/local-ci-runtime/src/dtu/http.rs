use super::*;

pub(super) fn accept_loop(listener: TcpListener, state: Arc<DtuState>, shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let state = Arc::clone(&state);
                thread::spawn(move || handle_connection(stream, state));
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
}

pub(super) fn handle_connection(mut stream: TcpStream, state: Arc<DtuState>) {
    let debug = std::env::var("LOCAL_CI_DTU_DEBUG").is_ok_and(|value| value == "1");
    let response = match read_request(&mut stream) {
        Ok(request) => {
            let response = route_request(&request, &state);
            if debug {
                eprintln!(
                    "[DTU] {} {} -> {}",
                    request.method, request.path, response.status
                );
            }
            if let Some(file) = std::env::var_os("LOCAL_CI_DTU_DEBUG_FILE") {
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(file)
                    .and_then(|mut file| {
                        writeln!(
                            file,
                            "{} {} -> {} body={} {:?}",
                            request.method,
                            request.path,
                            response.status,
                            request.body.len(),
                            String::from_utf8_lossy(&request.body)
                                .chars()
                                .take(200)
                                .collect::<String>()
                        )
                    });
            }
            response
        }
        Err(err) => {
            if debug {
                eprintln!("[DTU] Bad request: {err}");
            }
            if let Some(file) = std::env::var_os("LOCAL_CI_DTU_DEBUG_FILE") {
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(file)
                    .and_then(|mut file| writeln!(file, "BAD REQUEST {err}"));
            }
            Response::text(400, format!("Bad Request: {err}"))
        }
    };
    let _ = write_response(&mut stream, response);
    let _ = stream.flush();
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Request {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) query: BTreeMap<String, String>,
    pub(super) headers: BTreeMap<String, String>,
    pub(super) body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Response {
    pub(super) status: u16,
    pub(super) content_type: String,
    pub(super) body: Vec<u8>,
    pub(super) content_length: Option<usize>,
    pub(super) extra_headers: BTreeMap<String, String>,
}

impl Response {
    pub(super) fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain".to_owned(),
            body: Vec::new(),
            content_length: Some(0),
            extra_headers: BTreeMap::new(),
        }
    }

    pub(super) fn text(status: u16, text: impl Into<String>) -> Self {
        let body = text.into().into_bytes();
        Self {
            status,
            content_type: "text/plain".to_owned(),
            content_length: Some(body.len()),
            body,
            extra_headers: BTreeMap::new(),
        }
    }

    pub(super) fn json(status: u16, value: Value) -> Self {
        let body = serde_json::to_vec(&value).unwrap_or_default();
        Self {
            status,
            content_type: "application/json; charset=utf-8".to_owned(),
            content_length: Some(body.len()),
            body,
            extra_headers: BTreeMap::new(),
        }
    }

    pub(super) fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.to_owned(),
            content_length: Some(body.len()),
            body,
            extra_headers: BTreeMap::new(),
        }
    }

    pub(super) fn streaming_bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.to_owned(),
            content_length: None,
            body,
            extra_headers: BTreeMap::new(),
        }
    }
}

pub(super) fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|err| err.to_string())?;
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 4096];
    let header_end;

    loop {
        let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
        if read == 0 {
            return Err("connection closed before headers".to_owned());
        }
        buffer.extend_from_slice(&temp[..read]);
        if let Some(pos) = find_header_end(&buffer) {
            header_end = pos;
            break;
        }
        if buffer.len() > 1024 * 1024 {
            return Err("headers too large".to_owned());
        }
    }

    let header = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_owned())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "missing method".to_owned())?
        .to_owned();
    let target = request_parts
        .next()
        .ok_or_else(|| "missing target".to_owned())?;
    let (path, query) = split_target(target);
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }

    let body_start = header_end + 4;
    let mut body = buffer.get(body_start..).unwrap_or_default().to_vec();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        body = read_chunked_body(stream, body, &mut temp)?;
    } else {
        let content_length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        while body.len() < content_length {
            let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&temp[..read]);
        }
        body.truncate(content_length);
    }

    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

pub(super) fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

pub(super) fn read_chunked_body(
    stream: &mut TcpStream,
    mut encoded: Vec<u8>,
    temp: &mut [u8; 4096],
) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    let mut cursor = 0;
    loop {
        let line_end = loop {
            if let Some(relative) = encoded[cursor..]
                .windows(2)
                .position(|window| window == b"\r\n")
            {
                break cursor + relative;
            }
            let read = stream.read(temp).map_err(|err| err.to_string())?;
            if read == 0 {
                return Err("connection closed while reading chunk size".to_owned());
            }
            encoded.extend_from_slice(&temp[..read]);
        };
        let size_line =
            std::str::from_utf8(&encoded[cursor..line_end]).map_err(|err| err.to_string())?;
        let size_hex = size_line.split(';').next().unwrap_or(size_line).trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| format!("invalid chunk size: {size_line}"))?;
        cursor = line_end + 2;
        if size == 0 {
            return Ok(decoded);
        }
        while encoded.len() < cursor + size + 2 {
            let read = stream.read(temp).map_err(|err| err.to_string())?;
            if read == 0 {
                return Err("connection closed while reading chunk body".to_owned());
            }
            encoded.extend_from_slice(&temp[..read]);
        }
        decoded.extend_from_slice(&encoded[cursor..cursor + size]);
        cursor += size;
        if encoded.get(cursor..cursor + 2) != Some(b"\r\n") {
            return Err("chunk body missing trailing CRLF".to_owned());
        }
        cursor += 2;
    }
}

pub(super) fn split_target(target: &str) -> (String, BTreeMap<String, String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let query = query
        .split('&')
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            Some((url_decode(key)?, url_decode(value).unwrap_or_default()))
        })
        .collect();
    (path.to_owned(), query)
}

pub(super) fn url_decode(value: &str) -> Option<String> {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

pub(super) fn write_response(stream: &mut TcpStream, response: Response) -> std::io::Result<()> {
    let status_text = status_text(response.status);
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nConnection: close\r\n",
        response.status, status_text, response.content_type
    )?;
    if let Some(content_length) = response.content_length {
        write!(stream, "Content-Length: {content_length}\r\n")?;
    }
    for (key, value) in response.extra_headers {
        write!(stream, "{key}: {value}\r\n")?;
    }
    stream.write_all(b"\r\n")?;
    stream.write_all(&response.body)
}

pub(super) fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        _ => "OK",
    }
}
