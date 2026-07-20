public class VertexDiscountConsumer {
  public void run(Decimal base, Decimal rate) {
    Decimal a = VertexDiscountCalculator.calculate(base);
    // -> VertexDiscountCalculator.calculate(Decimal) [via=static, arity=1] [MUST]
    VertexDiscountCalculator calc = new VertexDiscountCalculator();
    Decimal b = calc.calculate(base, rate);
    // -> VertexDiscountCalculator.calculate(Decimal,Decimal) [via=typed, arity=2] [MUST]
  }
}
