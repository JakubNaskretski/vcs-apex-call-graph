public class VertexDiscountCalculator {
  public static Decimal calculate(Decimal base) {
    return base;
  }
  public Decimal calculate(Decimal base, Decimal rate) {
    return base * (1 - rate);
  }
}
