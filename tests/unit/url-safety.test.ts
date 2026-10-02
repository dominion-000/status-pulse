import { describe, expect, it } from "vitest";
import { checkServiceUrl, isForbiddenIp } from "../../src/core/url-safety";

describe("isForbiddenIp: IPv4 (SP-02.3)", () => {
  it.each([
    "0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.168.1.1", "198.18.0.1",
    "198.19.255.255", "198.51.100.1", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
  ])("refuses %s", (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "11.0.0.0", "100.63.255.255", "100.128.0.0", "169.253.0.1",
    "172.15.255.255", "172.32.0.0", "192.169.0.1", "223.255.255.255",
  ])("allows %s, just outside a refused range or plainly public", (ip) => {
    expect(isForbiddenIp(ip)).toBe(false);
  });
});

describe("isForbiddenIp: IPv6 (SP-02.3)", () => {
  it.each([
    "::", "::1", "::2", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1",
    "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456:789a::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1",
    "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2002:a9fe:a9fe::",
  ])("refuses %s", (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "64:ff9b::808:808", "2002:808:808::1", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => {
      expect(isForbiddenIp(ip)).toBe(false);
    },
  );
});

describe("isForbiddenIp: anything that is not an IP address", () => {
  it.each(["example.com", "", "999.1.1.1", "1.2.3", "::g", ":::"])("refuses %j", (value) => {
    expect(isForbiddenIp(value)).toBe(true);
  });
});

describe("checkServiceUrl: addresses written in disguise", () => {
  it.each([
    ["decimal", "http://2130706433/"],
    ["hexadecimal", "http://0x7f000001/"],
    ["octal", "http://0177.0.0.1/"],
    ["short form", "http://127.1/"],
    ["zero", "http://0/"],
    ["metadata address", "http://169.254.169.254/latest/meta-data"],
    ["IPv6 loopback", "http://[::1]:8080/"],
    ["IPv4 inside IPv6", "http://[::ffff:127.0.0.1]/"],
    ["IPv4 inside IPv6, hex", "http://[::ffff:7f00:1]/"],
    ["private network", "https://192.168.0.10/status"],
  ])("rejects %s", (_label, url) => {
    expect(checkServiceUrl(url).issues.length).toBeGreaterThan(0);
  });
});

describe("checkServiceUrl: names that are not public", () => {
  it.each([
    "http://localhost:3000", "http://LOCALHOST/", "http://localhost./", "http://app.localhost/", "http://printer.local/",
    "http://metadata.google.internal/", "http://router.lan/", "http://nas.home.arpa/", "http://redis/", "http://db:5432/",
  ])("rejects %s", (url) => {
    expect(checkServiceUrl(url).issues.length).toBeGreaterThan(0);
  });
});

describe("checkServiceUrl: malformed or unsupported URLs", () => {
  it.each(["not a url", "", "http://", "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)"])(
    "rejects %j",
    (url) => {
      expect(checkServiceUrl(url).issues.length).toBeGreaterThan(0);
    },
  );

  it("rejects credentials embedded in the URL", () => {
    expect(checkServiceUrl("http://user:pw@example.com").issues).toContain("must not contain credentials");
    expect(checkServiceUrl("http://:pw@example.com").issues).toContain("must not contain credentials");
  });

  it("names the problem so it can be shown to the owner", () => {
    expect(checkServiceUrl("ftp://example.com").issues).toContain("must use http or https");
    expect(checkServiceUrl("http://127.0.0.1").issues).toContain("host is a private, loopback or link-local address");
  });
});

describe("checkServiceUrl: accepted URLs", () => {
  it.each([
    "https://example.com/health", "http://example.com:8080/x?y=1", "https://sub.domain.example.org",
    "HTTP://EXAMPLE.COM", "https://93.184.216.34/", "https://[2606:4700:4700::1111]/",
  ])("accepts %s", (url) => {
    const result = checkServiceUrl(url);
    expect(result.issues).toEqual([]);
    expect(result.url).not.toBeNull();
  });
});
