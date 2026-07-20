/**
 * Deliberately broken fixture: the closing brace for the class body is
 * missing. This file is expected to yield parseError != null.
 */
public class AcmeBrokenParser {
    public Integer brokenMethod(Integer input) {
        Integer result = input * 2;
        if (result > 10) {
            result = result - 1;
        }
        return result;
    }
