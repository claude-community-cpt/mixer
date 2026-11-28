import { describe, expect, test } from "bun:test";
import { experienceOf, parseCsv, readSignups, roleGroup } from "./signups.ts";

const EXPORT = [
  'api_id,name,first_name,last_name,email,phone_number,created_at,approval_status,"What is your experience level with Claude Code?","What question or topic would you like to submit for discussion on the day? (Can be serious, practical, or fun)",Are you willing to facilitate the discussion at your table?,Where do you work or study?,"What is your role? (If Student, write Student)"',
  'gst-1,Sam Example,Sam,Example,Sam@Example.com,+27000000000,2026-11-20,approved,Daily user,"How do you check Claude\'s work, quickly?",Yes,Example Co,Senior Software Engineer',
  'gst-2,Thandi Example,Thandi,Example,thandi@example.com,,2026-11-21,approved,Regular user (multiple times per week),"A question',
  'over two lines",No,Example Uni,Student',
  "gst-3,Pat Example,Pat,Example,pat@example.com,,2026-11-22,pending_approval,New but highly interested,none,Yes,,Founder",
  "gst-4,Lee Example,Lee,Example,lee@example.com,,2026-11-22,approved,Occasional user,N/A,,,",
].join("\n");

describe("parseCsv", () => {
  test("handles quotes, commas and line breaks inside a cell", () => {
    expect(parseCsv('a,"b, ""c""",d\r\n"one\ntwo",,x\n')).toEqual([["a", 'b, "c"', "d"], ["one\ntwo", "", "x"]]);
  });
});

describe("readSignups", () => {
  const out = readSignups(EXPORT)!;
  test("keeps approved guests only", () => {
    expect(out.rows.map((r) => r.firstName)).toEqual(["Sam", "Thandi", "Lee"]);
    expect(out.notApproved).toBe(1);
  });
  test("takes only the columns the app needs", () => {
    expect(out.rows[0]).toEqual({
      email: "sam@example.com", firstName: "Sam", experience: "daily", willHost: true, role: "engineering",
      question: "How do you check Claude's work, quickly?",
    });
    expect(JSON.stringify(out.rows)).not.toContain("Example Co");
    expect(JSON.stringify(out.rows)).not.toContain("+27");
  });
  test("reads the answers", () => {
    expect(out.rows[1]).toMatchObject({ experience: "regular", willHost: false, role: "student", question: "A question over two lines" });
    expect(out.rows[2]).toMatchObject({ experience: "occasional", willHost: false, role: null, question: null });
  });
  test("a plain list of addresses is not an export", () => {
    expect(readSignups("sam@example.com\nlee@example.com")).toBeNull();
  });
});

describe("answers", () => {
  test("experience levels", () => {
    expect(experienceOf("New but highly interested")).toBe("new");
    expect(experienceOf("")).toBeNull();
  });
  test("kinds of work", () => {
    expect(roleGroup("CTO")).toBe("leadership");
    expect(roleGroup("Data Engineer")).toBe("data");
    expect(roleGroup("UX designer")).toBe("design");
    expect(roleGroup("Product Manager")).toBe("product");
    expect(roleGroup("Beekeeper")).toBe("other");
    expect(roleGroup(" ")).toBeNull();
  });
});
