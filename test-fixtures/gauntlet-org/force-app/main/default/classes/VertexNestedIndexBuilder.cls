public class VertexNestedIndexBuilder {
  public Map<String, List<Map<Id, VertexIndexEntry>>> buildIndex() {
    Map<String, List<Map<Id, VertexIndexEntry>>> nestedIndex = new Map<String, List<Map<Id, VertexIndexEntry>>>();
    nestedIndex.put('default', new List<Map<Id, VertexIndexEntry>>());
    return nestedIndex;
  }
}
