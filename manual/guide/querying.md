# Querying

Querying data allows you to see all selections coded with particular codes.

## See all selections with a code

**To see all selections with a code:**

1. In the Code Browser, right-click on the code you wish to query.

2. Select either `Show in Active Document` or `Show in All Documents`.

   <figure>
     <img src="./images/RightClickCode.png" alt="The contextual menu for the Code Browser.">
     <figcaption>The contextual menu for the Code Browser.</figcaption>
   </figure>

3. The matching selections are shown in the Query Results pane.

   <figure>
     <img src="./images/QueryResults.png" alt="The Query Results pane.">
     <figcaption>The Query Results pane.</figcaption>
   </figure>

4. You can save the query to be run later by clicking `Save Query` in the Query Results pane. Magnolia will suggest a name for the query, but you are free to change it.

## The Document Selector
The Query tool contains the [Document Selector](/guide/documentselector). It can be used to target your query to specific documents. 

By default, the Document Selector is collapsed and applies your query to all documents in your project.
<figure>
     <img src="./images/DocumentSelectorCollapsed.png" alt="The Document Selector in its default, collapsed state.">
     <figcaption>The Document Selector in its default, collapsed state.</figcaption>
</figure>

## The Query Builder

The Query Builder allows you to create complex queries that target specific documents, groups of documents, survey questions, or survey respondents.

To open the Query Builder, click the `Query` button in the toolbar.

The Query Builder has two sections: `From these documents`, which is the [Document Selector](/guide/documentselector), and `Find this content`, where you build the query itself.

The Document Selector is, by default, collapsed. It will apply your query to all documents unless you specify otherwise.

When a new query is created, the Query Builder is empty.

<figure>
  <img src="./images/EmptyQueryBuilder.png" alt="The empty query builder.">
  <figcaption>The empty query builder, ready for a query to be built.</figcaption>
</figure>

The Query Builder is a visual, node-based editor. Think of it like a pipeline that you can pour different things into.

**To create a query:**

1. Drag a code from the Code Browser onto the Query Builder's canvas; and,

2. Click and drag on the connection point to connect it to the Results output.

   <figure>
     <img src="./images/SimpleQueryBuilder.png" alt="The query builder with a simple query.">
     <figcaption>The query builder with a simple query.</figcaption>
   </figure>

3. Ensure it is connected the Results node.

## Searching for text

**To search for a string of text:**

1. Drag the text node onto the canvas.

   <figure>
     <img src="./images/TextInput.png" alt="The text node.">
     <figcaption>The text node.</figcaption>
   </figure>

2. Insert the text you wish to search for, whether it is case-sensitive, and whether you are looking for a whole word.

3. Ensure it is connected the Results node.

## Logical operators

You can add logical operators into your query to refine it. Magnolia uses the common boolean logical operators:

| Operator | Output |
| --- | --- |
| AND | Outputs segments where all inputs are met |
| OR | Outputs segments where any of the inputs are met | 
| NOT | Outputs segments that do not match the inputs | 
| XOR | Outputs segments where one, but not more, of the inputs are met | 

**To use a logical operator:**

1. Drag the logical operator onto the canvas.

   <figure>
     <img src="./images/LogicalOperator.png" alt="The logical operator node.">
     <figcaption>The logical operator node.</figcaption>
   </figure>

2. Select the type of logical operator you would like to apply from the drop-down list.

3. Wire up the inputs you want the logical operator to take.

4. Ensure it is connected the Results node.

## Spatial operators

You can add spatial operators into your query to refine it. Spatial operators return coded segments based on their position in relation to other coded segments.

| Operator | Output |
| --- | --- |
| Overlapping | Outputs segments where Code 1 and Code 2 overlap |
| Inside | Outputs segments where Code 1 is fully inside by Code 2 | 
| Outside | Outputs segments of Code 1 that do not overlap with Code 2 | 
| Before | Outputs segments of Input 1 where Input 1 ends before Input 2, with no overlap between them | 
| Followed By | Outputs segments of Input 1 where Input 1 starts after Input 2, with no overlap between them | 
| Same Sentence | Outputs the sentences that contain both Input 1 and Input 2 | 

<figure>
     <img src="./images/SpatialOperators.png" alt="The spatial operator nodes.">
     <figcaption>The spatial operator nodes.</figcaption>
</figure>

### Finding things in the same sentence

The Same Sentence operator finds the sentences where two things appear together. Its inputs can be two pieces of text, a piece of text and a code, or two codes. For example, connecting the text "rent" and the text "worry" finds every sentence containing both words. Each result is the whole sentence.

A sentence ends at a full stop, a question mark or an exclamation mark, or at a line break.

::: tip
The Same Sentence operator must be connected straight to the Results node. Its sentences can't be used as an input to another operator.
:::

## An example

Imagine you have the following segment of coded text.

<figure>
     <img src="./images/ComplexCodedSegment.png" alt="A segment of text with a lot of codes applied.">
     <figcaption>A segment of text with a lot of codes applied.</figcaption>
</figure>

### And
<figure>
     <img src="./images/And.png" alt="The and logical operator.">
     <figcaption>The AND logical operator.</figcaption>
</figure>
Produces: 

- ``` 'Twas his shearing mate who wrote it```

### Or
<figure>
     <img src="./images/Or.png" alt="The or logical operator.">
     <figcaption>The OR logical operator.</figcaption>
</figure>
Produces: 

- ``` 'Twas his shearing mate who wrote it```
- ``` I had written him a letter```
- ```(And I think the same was written with a thumb-nail dipped in tar)```
- ``` 'Twas his shearing mate who wrote it```
- ``` Clancy's gone to Queensland droving```

::: info
In this example, ``` 'Twas his shearing mate who wrote it``` is returned twice because it matches both Code 1 and Code 2. It is an act of writing about sheep—fulfilling the great Australian literary tradition of writing about these fluffy creatures.
:::

### Not
<figure>
     <img src="./images/Not.png" alt="The not logical operator.">
     <figcaption>The NOT logical operator.</figcaption>
</figure>
Produces: 

- ``` 'Twas his shearing mate who wrote it```
- ``` Clancy's gone to Queensland droving```

::: info
Conceptually, the NOT operator is perhaps the most difficult to understand. This is because it just flips whatever is put into it. This can lead to a lot of output, because it effectively asks Magnolia to "show everything that is not coded with whatever I am putting in".  

The example above, while it looks intimidating, is essentially just the same as saying "show me all segments about sheep that are not in the first stanza". You could accomplish this same result in other ways, such as by using the OUTSIDE code. 
:::

### Xor
<figure>
     <img src="./images/Xor.png" alt="The Xor logical operator.">
     <figcaption>The XOR logical operator.</figcaption>
</figure>
Produces: 

- ``` He was shearing when I knew him```
- ``` I had written him a letter```
- ```(And I think the same was written with a thumb-nail dipped in tar)```
- ``` Clancy's gone to Queensland droving```

::: info
The Xor logical operator is pronounced "exclusive or". In this example, ``` 'Twas his shearing mate who wrote it``` is not returned because this segment is both an act of writing and about sheep. It therefore meets both conditions, and because of this, it is excluded (it is not exclusively about sheep or an act of writing).
:::

### Overlapping
<figure>
     <img src="./images/Overlapping.png" alt="The overlapping spatial operator.">
     <figcaption>The overlapping spatial operator.</figcaption>
</figure>
Produces: 

- ``` 'Twas his shearing mate who wrote it```

### Inside
<figure>
     <img src="./images/Inside.png" alt="The inside spatial operator.">
     <figcaption>The inside spatial operator.</figcaption>
</figure>
Produces: 

- ``` He was shearing when I knew him```

### Outside
<figure>
     <img src="./images/Outside.png" alt="The outside spatial operator.">
     <figcaption>The outside spatial operator.</figcaption>
</figure>
Produces: 

- ``` 'Twas his shearing mate who wrote it```
- ``` Clancy's gone to Queensland droving```

### Before
<figure>
     <img src="./images/Before.png" alt="The before spatial operator.">
     <figcaption>The before spatial operator.</figcaption>
</figure>
Produces: 

- ``` He was shearing when I knew him```

### Followed By
<figure>
     <img src="./images/FollowedBy.png" alt="The followed by spatial operator.">
     <figcaption>The followed by spatial operator.</figcaption>
</figure>
Produces: 

- ```(And I think the same was written with a thumb-nail dipped in tar)```

::: info
In this example, ``` 'Twas his shearing mate who wrote it``` is not returned because the two codes overlap on that segment.
:::